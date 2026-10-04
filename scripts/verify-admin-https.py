"""Read-only deployment acceptance. No inference, writes, or provider credentials.

Run from the Linux checkout after deployment. A private generated bootstrap file
supplies Basic auth in memory; after rotation, run interactively for the password.
"""
import base64
import getpass
import hashlib
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess

HOST = "devin-admin.home.arpa"


def compose(*args):
    result = subprocess.run(["docker", "compose", *args], capture_output=True,
                            text=True, timeout=20)
    if result.returncode:
        raise RuntimeError("Read-only deployment inspection failed.")
    return result.stdout


def main():
    root = Path(__file__).resolve().parents[1]
    env = {}
    for line in (root / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")
    address = env["DEVIN_GATEWAY_BIND_IP"]
    credential = root / "secrets" / "devin-admin-bootstrap.json"
    if credential.exists():
        user = json.loads(credential.read_text())
        username, password = user["username"], user["password"]
    else:
        username, password = "admin", getpass.getpass("Admin password (not echoed): ")
    authorization = "Basic " + base64.b64encode((username + ":" + password).encode()).decode()
    certificate = compose("exec", "-T", "devin-admin-proxy", "cat",
                          "/data/caddy/pki/authorities/local/root.crt")
    context = ssl.create_default_context(cadata=certificate)

    def request(path, headers=None):
        connection = http.client.HTTPConnection(HOST, 443, timeout=10)
        try:
            connection.sock = context.wrap_socket(socket.create_connection((address, 443), timeout=10),
                                                   server_hostname=HOST)
            connection.request("GET", path, headers={"Host": HOST, **(headers or {})})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def settings_hashes():
        result = {}
        for filename in ["model-selection.json", "model-test-status.json"]:
            data = compose("exec", "-T", "devin-gateway", "cat",
                           "/home/gateway/.devin-gateway-settings/" + filename)
            result[filename] = hashlib.sha256(data.encode()).hexdigest()
        return result

    before = settings_hashes()
    assert request("/admin/")[0] == 401
    auth = {"Authorization": authorization}
    for path in ["/admin/", "/admin/assets/model-picker.js", "/admin/assets/model-picker.css",
                 "/admin/assets/third-party-notices.txt", "/admin/api/models",
                 "/admin/api/model-selection", "/admin/api/model-test-status"]:
        status, body = request(path, auth)
        assert status == 200, "Approved resource returned HTTP " + str(status)
        if path.endswith("model-selection"):
            print("selection_revision=" + str(json.loads(body)["revision"]))
        if path.endswith("model-test-status"):
            print("test_status_revision=" + str(json.loads(body)["revision"]))
    for headers in [{"Host": "wrong.example"}, {"Origin": "https://foreign.example"},
                    {"Sec-Fetch-Site": "cross-site"}]:
        assert request("/admin/", {**auth, **headers})[0] in (403, 404, 421)
    assert request("/admin/api/model-selection", {**auth, "Origin": "https://" + HOST,
                   "Sec-Fetch-Site": "same-origin"})[0] == 200
    for path in ["/", "/health", "/v1/models", "/gateway/api/codex-selection",
                 "/admin/api/extra", "/config/"]:
        assert request(path, auth)[0] == 404
    assert before == settings_hashes()
    try:
        raw = socket.create_connection(("127.0.0.1", 38644), timeout=2)
    except OSError:
        pass
    else:
        raw.close()
        raise AssertionError("Former raw admin port remains reachable.")
    tcp = compose("exec", "-T", "devin-gateway", "cat", "/proc/net/tcp")
    listeners = [line.split()[1] for line in tcp.splitlines()[1:]
                 if line.split()[3] == "0A" and line.split()[1].endswith(":0BB9")]
    assert listeners == ["0100007F:0BB9"], "Management must listen only on loopback."
    health_connection = http.client.HTTPConnection(address, 38643, timeout=5)
    try:
        health_connection.request("GET", "/health")
        response = health_connection.getresponse()
        health = json.loads(response.read())
        assert response.status == 200 and health["status"] == "ok"
        assert health["fallback_token"] == "set" and health["collapse_system_enabled"] is True
    finally:
        health_connection.close()
    print("PASS: authenticated HTTPS resources, rejection checks, verified TLS, loopback management,")
    print("unchanged settings/status bytes and inference health; no inference performed.")


if __name__ == "__main__":
    main()
