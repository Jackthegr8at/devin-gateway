# Permanent private admin HTTPS

The existing picker is at `https://devin-admin.home.arpa/admin/`. It is not a
second UI or inference proxy. DNS is operator-managed: map this hostname to the
gateway host's private address. Do not publish public DNS or router forwarding.

## Network and security contract

- `devin-gateway` owns the Docker network namespace and all published ports.
  Inference retains its exact private `38643:3000` mapping. HTTPS adds private
  `443:443`; the old `38644:3001` publication is removed.
- `devin-admin-proxy` shares `network_mode: service:devin-gateway` and has no
  `ports` or separate `networks`. Management binds `127.0.0.1:3001` inside that
  namespace, inaccessible through the bridge or LAN. Caddy proxies loopback.
- Caddy 2.10.2-alpine is version-pinned. Its admin API and HTTP redirects are
  disabled; no port 80, 2019, or raw management port is published.
- `DEVIN_ADMIN_ALLOWED_CIDRS` is a required space-separated list of approved
  client networks in private `.env`. This supplements the private bind/firewall;
  Docker port publication must not be assumed to obey ordinary UFW rules alone.
- Exact external Host, present Origin, and fetch metadata are validated before
  translation. Only absent or `https://devin-admin.home.arpa` Origin is accepted;
  fetch site must be absent, `same-origin`, or `none`. Unmatched hosts are rejected.
- Basic authentication protects every forwarded resource. After validation, Host
  becomes `127.0.0.1:3001`; a present accepted Origin becomes
  `http://127.0.0.1:3001`. Authorization, Cookie and X-Api-Key are removed upstream.
  Discovery continues using the gateway's existing fallback credential.
- Gateway Host/Origin/fetch-metadata checks, CSRF management header, JSON bounds,
  ETags and no-store behavior remain unchanged. The browser uses same-origin
  credentials only, never cross-origin authentication or provider tokens.
- Only `/admin/`, three fixed asset paths, and the models, model-selection and
  model-test-status APIs are forwarded. The HTML page is the fourth static
  resource. All other paths are rejected, including health, inference, Codex
  export and Caddy administration. No proxy access/debug logging is enabled.

## Private credentials

Set `.env` private bind/CIDRs and create the private secret before starting:

```sh
# Run from the checkout on the Linux Docker host, with Docker permission.
sudo python3 scripts/bootstrap-admin-auth.py --generate
docker compose config --quiet
docker compose run --rm --no-deps devin-admin-proxy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose build devin-gateway
docker compose up -d --force-recreate devin-gateway devin-admin-proxy
```

The helper uses the official Caddy `hash-password` command with password input
through stdin, not arguments/logs. It creates `secrets/` mode 0700 and private
files mode 0600. `secrets/devin-admin-users.caddy` contains the username/hash and
is mounted read-only as `/run/secrets/devin_admin_users`. The generated initial
password is retained only in `secrets/devin-admin-bootstrap.json` for the operator
to retrieve privately over SSH. Do not post it in chat. Existing credentials
are never overwritten by `--generate`; both Git and Docker build ignore secrets.

Rotate to your own password after bootstrap:

```sh
sudo python3 scripts/bootstrap-admin-auth.py --rotate
docker compose up -d --no-deps --force-recreate devin-admin-proxy
```

Rotation prompts without echo, stores only the new hash, and removes the obsolete
bootstrap file. The Basic login is always over TLS; the browser can cache the old
login, so use a fresh browser session after rotation. This is independent of Devin
OAuth: no OAuth token file/volume is read or modified by either helper operation.

## Windows hostname and certificate trust

1. Configure local DNS or hosts for `devin-admin.home.arpa -> <private gateway IP>`.
2. Export **only** the public Caddy root certificate on the server:

```sh
docker compose cp devin-admin-proxy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

3. Copy `caddy-root.crt` over authenticated SSH. Verify its fingerprint through
   that trusted channel before importing it. Never export `root.key` or the whole
   Caddy data volume; a trusted CA root can sign other hostnames too.
4. In Windows PowerShell, import for the current user (replace the local path):

```powershell
Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

5. Open the HTTPS `/admin/` URL, authenticate as `admin`, and check current
   models/roles/Tested state. TLS warnings must be resolved, not bypassed for
   normal use. A harmless selection edit is a separate manual acceptance action.

## Persistence and restart

Auth/settings volume names and mount paths remain unchanged. Caddy has separate
`devin-admin-caddy-data` and `devin-admin-caddy-config` named volumes, preserving
its CA and certificate state. Never remove those volumes to restart services.
Both services use `unless-stopped`; Docker must be enabled at host boot. A
deliberately stopped service remains stopped after a reboot by design.

Process/container restarts preserve state. Compose v2.20.2 supports the explicit
dependency `restart: true`, but namespace-owner **recreation must recreate both**
services with the command above. Do not manually remove/recreate only the gateway
and assume a running sidecar has followed its replacement namespace. No boot-time
SSH action is necessary. After any restart verify health, HTTPS authentication,
and the current selection/status revision; do not run inference for these checks.

## Offline proxy validation and rollback

```sh
sudo python3 scripts/test-admin-proxy.py
```

This runs Caddy against a synthetic loopback backend on disposable ports and
private temporary paths. It never reads production credentials/volumes or calls
Devin. The fixture removes its own container and temporary CA after completion.
Gateway backend security tests remain required alongside this proxy test.

After deployment, `sudo python3 scripts/verify-admin-https.py` performs GET-only
acceptance using the private bootstrap credential (or a non-echoed password prompt
after rotation). It verifies the actual Caddy CA, allowed/denied routes, inference
health, raw-port removal, internal loopback binding and unchanged settings/status
bytes. It prints only fixed results/revisions and never the credential or bodies.

Before deployment record the previous commit/image and hashes of selection/status
files, without printing their contents. If rollback is needed, stop only
`devin-admin-proxy`, restore the recorded gateway checkout/image and recreate
the gateway using that revision's Compose file. Retain all named volumes and
private secret files. The previous revision's SSH-only access remains available.
