"""Linux Nginx acceptance; synthetic password stays in memory, never printed.

--live-bootstrap validates the installed site and creates its hash-only account.
The account is LOCKED after acceptance; set your password interactively afterward.
Never reads gateway OAuth credentials or writes gateway selection/status.
"""
import argparse
import base64
import crypt
import grp
import http.client
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import tempfile
import threading
import time

HOST = "devin-admin.dev.kryptxt.ca"
ROUTES = ["/admin/", "/admin/api/models", "/admin/api/model-selection",
          "/admin/api/model-test-status", "/admin/assets/model-picker.js",
          "/admin/assets/model-picker.css", "/admin/assets/third-party-notices.txt"]


def private_hash(path, value, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o640)
    with os.fdopen(fd, "w") as handle:
        os.fchown(handle.fileno(), 0, grp.getgrnam("www-data").gr_gid)
        os.fchmod(handle.fileno(), 0o640)
        handle.write("admin:" + value + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def request(port, path, headers=None, address="127.0.0.1", source=None):
    context = ssl.create_default_context()
    connection = http.client.HTTPConnection(HOST, port, timeout=65)
    try:
        connection.sock = context.wrap_socket(socket.create_connection((address, port), timeout=3,
                                              source_address=(source, 0) if source else None),
                                              server_hostname=HOST)
        connection.request("GET", path, headers={"Host": HOST, **(headers or {})})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def security_checks(port, authorization, address="127.0.0.1"):
    assert request(port, "/admin/", address=address)[0] == 401
    assert request(port, "/admin/", {"Authorization": "Basic invalid"}, address)[0] == 401
    auth = {"Authorization": authorization}
    for path in ROUTES:
        status, body = request(port, path, auth, address)
        assert status == 200, "Approved resource returned HTTP " + str(status)
        if path.endswith("model-selection") and address != "127.0.0.1":
            print("selection_revision=" + str(json.loads(body)["revision"]))
        if path.endswith("model-test-status") and address != "127.0.0.1":
            print("test_status_revision=" + str(json.loads(body)["revision"]))
    for headers in [{"Host": HOST + ":443"}, {"Origin": "https://foreign.example"},
                    {"Sec-Fetch-Site": "cross-site"}]:
        assert request(port, "/admin/", {**auth, **headers}, address)[0] == 403
    for path in ["/", "/health", "/v1/models", "/gateway/api/codex-selection",
                 "/admin/api/extra", "/admin/assets/extra.js"]:
        assert request(port, path, auth, address)[0] == 404
    assert request(port, "/admin/api/model-selection", {**auth, "Origin": "https://" + HOST,
                   "Sec-Fetch-Site": "same-origin", "Cookie": "synthetic-cookie",
                   "X-Api-Key": "synthetic-key"}, address)[0] == 200


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-bootstrap", action="store_true")
    parser.add_argument("--gateway-ip")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run on the Nginx host as root; credentials are never displayed.")
    password = secrets.token_urlsafe(40)
    password_hash = crypt.crypt(password, crypt.mksalt(crypt.METHOD_SHA512))
    authorization = "Basic " + base64.b64encode(("admin:" + password).encode()).decode()
    observed = []

    class Backend(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            observed.append({name: self.headers.get(name) for name in
                             ["Host", "Origin", "Authorization", "Cookie", "X-Api-Key"]})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_):
            pass

    backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="devin-nginx-test-") as folder:
            root = Path(folder)
            root.chmod(0o755)
            auth_file = root / "htpasswd"
            private_hash(auth_file, password_hash, exclusive=True)
            source = Path(__file__).resolve().parents[1] / "deploy/nginx-devin-admin.conf"
            site = source.read_text().replace("__GATEWAY_IP__:38644", "127.0.0.1:" + str(backend.server_port))
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            listener.close()
            site = site.replace("listen 443 ssl http2;", "listen 127.0.0.1:" + str(port) + " ssl;")
            site = site.replace("listen [::]:443 ssl;", "")
            site = site.replace("allow 192.168.0.0/24;", "allow 127.0.0.1;")
            site = site.replace("/etc/nginx/auth/devin-admin.htpasswd", str(auth_file))
            config = root / "nginx.conf"
            config.write_text("user www-data;\npid " + str(root / "nginx.pid") + ";\n"
                              "error_log " + str(root / "error.log") + ";\n"
                              "events {}\nhttp { access_log off;\n" + site + "\n}\n")
            subprocess.run(["nginx", "-t", "-c", str(config)], check=True, capture_output=True, timeout=5)
            process = subprocess.Popen(["nginx", "-c", str(config), "-g", "daemon off;"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(50):
                try:
                    if request(port, "/admin/")[0] == 401:
                        break
                except OSError:
                    time.sleep(0.1)
            security_checks(port, authorization)
            assert observed and all(item["Host"] == "127.0.0.1:3001" for item in observed)
            assert all(not item[name] for item in observed for name in ["Authorization", "Cookie", "X-Api-Key"])
            assert observed[-1]["Origin"] == "http://127.0.0.1:3001"
            assert observed[0]["Origin"] is None
            before = len(observed)
            assert request(port, "/admin/", {"Authorization": authorization}, source="127.0.0.2")[0] == 403
            assert request(port, "/admin/", {"Host": "foreign.example", "Authorization": authorization})[0] == 403
            assert len(observed) == before
            print("PASS: isolated Nginx TLS/auth/route/Host/Origin/fetch validation and upstream credential stripping")
            process.terminate()
            process.wait(timeout=5)
            process = None
        if args.live_bootstrap:
            if not args.gateway_ip:
                raise SystemExit("--gateway-ip is required")
            auth_dir = Path("/etc/nginx/auth")
            auth_dir.mkdir(mode=0o750, exist_ok=True)
            os.chown(auth_dir, 0, grp.getgrnam("www-data").gr_gid)
            auth_dir.chmod(0o750)
            auth_file = auth_dir / "devin-admin.htpasswd"
            private_hash(auth_file, password_hash, exclusive=True)
            try:
                security_checks(443, authorization, args.gateway_ip)
                print("PASS: installed Nginx authenticated UI/APIs/assets and rejection checks; no inference")
            finally:
                # No usable bootstrap password remains after unattended acceptance.
                private_hash(auth_file, "!")
                print("Admin account locked; set its password using interactive htpasswd.")
    finally:
        if process:
            process.terminate()
            process.wait(timeout=5)
        backend.shutdown()
        backend.server_close()


if __name__ == "__main__":
    main()
