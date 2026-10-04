"""Local Docker/Caddy acceptance against a synthetic loopback backend only.

Run on Linux with Docker access: python3 scripts/test-admin-proxy.py
No Devin requests, real credentials, production volumes, or production ports.
"""
import base64
import http.client
import http.server
import os
import re
import shutil
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import uuid

IMAGE = "caddy:2.10.2-alpine"
HOST = "devin-admin.home.arpa"
ORIGIN = "https://" + HOST
ROUTES = ["/admin/", "/admin/api/models", "/admin/api/model-selection",
          "/admin/api/model-test-status", "/admin/assets/model-picker.js",
          "/admin/assets/model-picker.css", "/admin/assets/third-party-notices.txt"]


def docker(*args, data=None):
    result = subprocess.run(["docker", *args], input=data, text=True,
                            capture_output=True, timeout=60)
    if result.returncode:
        # Never reflect arbitrary container/config output (could contain secrets).
        if args[-1] == "caddyfile":
            # This command has only disposable, known-synthetic inputs.
            lines = [line for line in result.stderr.splitlines() if line.startswith("Error:")]
            if lines:
                print(re.sub(r"\$2[aby]\$\S+", "[synthetic hash omitted]", lines[-1]))
        raise RuntimeError("Disposable Docker operation failed: " + args[0])
    return result.stdout.strip()


def main():
    if os.name != "posix":
        raise SystemExit("Run the disposable proxy test on Linux with Docker access.")
    observed = []

    class Backend(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            observed.append(dict(self.headers))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"synthetic management response")

        def log_message(self, *_args):
            pass

    backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    with socket.socket() as free:
        free.bind(("127.0.0.1", 0))
        tls_port = free.getsockname()[1]
    name = "devin-admin-fixture-" + uuid.uuid4().hex
    try:
        with tempfile.TemporaryDirectory(prefix="devin-admin-fixture-") as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            password = "synthetic-proxy-password-not-a-real-credential"
            hashed = docker("run", "--rm", "-i", IMAGE, "caddy", "hash-password",
                            data=password + "\n")
            users = root / "users"
            users.write_text("fixture " + hashed + "\n")
            os.chmod(users, 0o600)
            source = Path(__file__).resolve().parents[1] / "deploy" / "Caddyfile"
            config = source.read_text().replace(
                "https://" + HOST + " {",
                "https://" + HOST + ":" + str(tls_port) + " {\n\tbind 127.0.0.1")
            config = config.replace("reverse_proxy http://127.0.0.1:3001",
                                    "reverse_proxy http://127.0.0.1:" + str(backend.server_port))
            config = config.replace("https://:443 {", "https://:" + str(tls_port) + " {\n\tbind 127.0.0.1")
            (root / "Caddyfile").write_text(config)
            mounts = ["-v", str(root / "Caddyfile") + ":/etc/caddy/Caddyfile:ro",
                      "-v", str(users) + ":/run/secrets/devin_admin_users:ro",
                      "-v", str(root) + ":/data",
                      "-e", "DEVIN_ADMIN_ALLOWED_CIDRS=127.0.0.1/32"]
            docker("run", "--rm", *mounts, IMAGE, "caddy", "validate",
                   "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile")
            docker("run", "-d", "--name", name, "--network", "host", *mounts, IMAGE)
            context = ssl._create_unverified_context()  # Disposable CA only.

            def request(path, headers=None):
                connection = http.client.HTTPConnection(HOST, tls_port, timeout=3)
                try:
                    connection.sock = context.wrap_socket(
                        socket.create_connection(("127.0.0.1", tls_port), timeout=3),
                        server_hostname=HOST)
                    connection.request("GET", path, headers={"Host": HOST, **(headers or {})})
                    response = connection.getresponse()
                    response.read()
                    return response.status
                finally:
                    connection.close()

            deadline = time.monotonic() + 20
            while True:
                try:
                    if request("/admin/") == 401:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Disposable HTTPS proxy did not become ready.")
                time.sleep(0.2)
            authorization = "Basic " + base64.b64encode(("fixture:" + password).encode()).decode()
            auth = {"Authorization": authorization}
            assert not observed
            checks = 1
            for path in ROUTES:
                assert request(path, auth) == 200
                checks += 1
            for index, headers in enumerate([
                {"Host": "wrong.example"}, {"Host": HOST + ":443"},
                {"Origin": "https://foreign.example"}, {"Origin": "http://" + HOST},
                {"Origin": "null"}, {"Origin": ""},
                {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
            ]):
                before = len(observed)
                status = request("/admin/", {**auth, **headers})
                assert status in (403, 404, 421), "Rejection fixture " + str(index) + " returned " + str(status) + "; backend delta=" + str(len(observed) - before)
                assert len(observed) == before
                checks += 1
            for site in [None, "none", "same-origin"]:
                headers = {**auth, "Origin": ORIGIN, "Cookie": "synthetic-cookie",
                           "X-Api-Key": "synthetic-api-key"}
                if site:
                    headers["Sec-Fetch-Site"] = site
                assert request("/admin/api/models", headers) == 200
                upstream = {k.lower(): v for k, v in observed[-1].items()}
                assert upstream["host"] == "127.0.0.1:3001"
                assert upstream["origin"] == "http://127.0.0.1:3001"
                assert not {"authorization", "cookie", "x-api-key"}.intersection(upstream)
                checks += 1
            assert request("/admin/", auth) == 200
            assert "Origin" not in observed[-1]
            checks += 1
            for path in ["/", "/health", "/v1/models", "/gateway/api/codex-selection",
                         "/admin", "/admin/extra", "/admin/api/extra", "/config/",
                         "/admin/assets/not-allowed.js"]:
                before = len(observed)
                assert request(path, auth) == 404
                assert len(observed) == before
                checks += 1
            # Exercise the real bootstrap helper only inside this disposable root.
            helper_dir = root / "scripts"
            helper_dir.mkdir()
            helper = helper_dir / "bootstrap-admin-auth.py"
            shutil.copyfile(Path(__file__).with_name(helper.name), helper)
            result = subprocess.run(["python3", str(helper), "--generate"],
                                    text=True, capture_output=True, timeout=60)
            assert result.returncode == 0
            private = root / "secrets"
            credential = private / "devin-admin-bootstrap.json"
            assert private.stat().st_mode & 0o777 == 0o700
            assert credential.stat().st_mode & 0o777 == 0o600
            import json
            generated = json.loads(credential.read_text())
            assert generated["password"] not in result.stdout + result.stderr
            hashed_file = private / "devin-admin-users.caddy"
            assert hashed_file.stat().st_mode & 0o777 == 0o600
            original_hash = hashed_file.read_bytes()
            repeated = subprocess.run(["python3", str(helper), "--generate"],
                                      text=True, capture_output=True, timeout=60)
            assert repeated.returncode != 0 and hashed_file.read_bytes() == original_hash
            # Non-interactive rotation uses only an explicitly synthetic fixture.
            rotate = "import getpass,runpy,sys; getpass.getpass=lambda *a:'synthetic-new-password-for-test'; sys.argv=[sys.argv[1],'--rotate']; runpy.run_path(sys.argv[0],run_name='__main__')"
            rotated = subprocess.run(["python3", "-c", rotate, str(helper)],
                                     text=True, capture_output=True, timeout=60)
            assert rotated.returncode == 0
            assert hashed_file.read_bytes() != original_hash and not credential.exists()
            assert hashed_file.stat().st_mode & 0o777 == 0o600
            assert not list(private.glob(".admin-auth-*"))
            checks += 7
            print("PASS: Caddy config and " + str(checks) + " proxy security checks; no Devin calls.")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15)
        backend.shutdown()
        backend.server_close()


if __name__ == "__main__":
    main()
