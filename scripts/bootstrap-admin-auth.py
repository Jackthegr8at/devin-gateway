"""Create/rotate private Caddy Basic auth on the Docker host; never print secrets."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

IMAGE = "caddy:2.10.2-alpine"


def replace_private(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix=".admin-auth-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--generate", action="store_true", help="One-time private bootstrap credential")
    group.add_argument("--rotate", action="store_true", help="Prompt for a replacement password without echo")
    options = parser.parse_args()
    if os.name != "posix":
        raise SystemExit("Run on the Linux Docker host.")
    directory = Path(__file__).resolve().parents[1] / "secrets"
    if directory.is_symlink():
        raise SystemExit("Refusing a symlink secret directory.")
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    users = directory / "devin-admin-users.caddy"
    bootstrap = directory / "devin-admin-bootstrap.json"
    if users.is_symlink() or bootstrap.is_symlink():
        raise SystemExit("Refusing symlink credential files.")
    if options.generate and (users.exists() or bootstrap.exists()):
        raise SystemExit("Existing admin credentials were not changed; use --rotate explicitly.")
    if options.rotate:
        password = getpass.getpass("New admin password: ")
        if password != getpass.getpass("Confirm admin password: ") or len(password) < 16:
            raise SystemExit("Passwords must match and contain at least 16 characters.")
    else:
        password = secrets.token_urlsafe(32)
    result = subprocess.run(["docker", "run", "--rm", "-i", IMAGE,
                             "caddy", "hash-password"], input=password + "\n",
                            text=True, capture_output=True, timeout=60)
    hashed = result.stdout.strip()
    if result.returncode or not hashed.startswith("$2a$") or len(hashed) != 60:
        raise SystemExit("Password hashing failed; no credential contents were printed.")
    # Write bootstrap before enabling its hash so a failed write cannot lose access.
    if options.generate:
        replace_private(bootstrap, json.dumps({"username": "admin", "password": password}) + "\n")
    replace_private(users, "admin " + hashed + "\n")
    if options.rotate and bootstrap.exists():
        bootstrap.unlink()
    print("Private admin credentials installed. No password/hash was printed.")
    print("Recreate devin-admin-proxy after a rotation; its read-only secret mount must be refreshed.")


if __name__ == "__main__":
    main()
