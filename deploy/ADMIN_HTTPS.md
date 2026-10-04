# Permanent internal Nginx admin HTTPS

Open `https://devin-admin.dev.kryptxt.ca/admin/`. DNS targets the existing Nginx
host, not the gateway. Reuse the wildcard Let's Encrypt certificate and its
existing renewal process; do not create or import another CA.

## Reviewed topology

Browser -> Nginx HTTPS + LAN/WireGuard allowlist + Basic authentication ->
private gateway host port 38644 -> container management port 3001.

Inference remains on private host port 38643. Management listens on 0.0.0.0
**inside the container only**, with host publication restricted to the configured
private IPv4. This is necessary because Nginx runs on a different host.
Neither the raw port nor the browser interface is anonymously available to LAN
clients. Do not expose management on host 0.0.0.0, IPv6 wildcard or public routing.

## Firewall first

Install `scripts/devin-admin-firewall.sh` as
`/usr/local/sbin/devin-admin-firewall` (root-owned, mode 0755). Adapt the two
IPv4 arguments in `deploy/20-devin-admin-firewall.conf` and install that file
under `/etc/systemd/system/docker.service.d/` (root-owned, mode 0644), after
the existing host firewall hook. Install the adapted
`deploy/devin-admin-firewall.service` under `/etc/systemd/system/` as well. Run:

```sh
sudo /usr/local/sbin/devin-admin-firewall <gateway-private-ip> <nginx-private-ip>
sudo systemctl daemon-reload
sudo systemctl enable --now devin-admin-firewall.service
sudo systemctl show docker -p ExecStartPost -p UnitFileState
sudo iptables -S DOCKER-USER
sudo iptables -S INPUT
```

The destination-specific deny matches original host port 38644 using conntrack,
before Docker's broad post-DNAT port-3001 permits. All sources except Nginx are
dropped. INPUT is restricted as well. Reapplication restores first position
without flushing unrelated rules. The existing LAN rules allow Nginx.
Keep Docker enabled at boot. Do not restart Docker simply to test the hook:
inspect its configuration and explicitly reapply the script.

The required oneshot installs restrictions after UFW but before Docker can start
containers on reboot. Raw PREROUTING denies non-proxy requests before DNAT,
independently of broad filter permits inserted by other startup hooks.
ExecStartPost reasserts filter rule ordering after the existing Docker firewall.
Do not assume UFW INPUT alone protects Docker publications.

## Nginx deployment

Adapt `deploy/nginx-devin-admin.conf`'s upstream IPv4 placeholder, install it in
`/etc/nginx/sites-available/devin-admin` and symlink it in sites-enabled. Keep
the existing certificate paths and approved LAN/WireGuard networks. Only this
site uses `/etc/nginx/auth/devin-admin.htpasswd`.

- Authentication and IP restrictions both apply (`satisfy all`).
- Exact external Host, optional HTTPS Origin and fetch metadata are checked
  before rewriting upstream Host/Origin to the existing loopback contract.
- Authorization, Cookie and X-Api-Key are removed before forwarding.
- Only the HTML page, three fixed assets and three admin APIs are proxied.
- Gateway Host/Origin/CSRF, ETag and persistence semantics remain unchanged.
- Existing host access/error log and logrotate conventions apply. Do not enable
  header/body debugging or put passwords in URLs.
- No other virtual host's authentication or routing is changed.

Validate with `sudo nginx -t`, then `sudo systemctl reload nginx`.

## Set or rotate the password

Run interactively on the Nginx host:

```sh
sudo install -d -o root -g www-data -m 0750 /etc/nginx/auth
sudo htpasswd -B /etc/nginx/auth/devin-admin.htpasswd admin
sudo chown root:www-data /etc/nginx/auth/devin-admin.htpasswd
sudo chmod 0640 /etc/nginx/auth/devin-admin.htpasswd
```

For a brand-new file only, add `-c` to htpasswd; never use `-c` to rotate an
existing multi-user file. Password prompts are not echoed. Do not use `-b`,
environment variables, command arguments or Git to carry passwords.
Only the hash remains on this host; no gateway/provider credential is involved.
Nginx reads the file for subsequent authentication without a reload. A private
browser window avoids cached old credentials after rotation.

Automated initial acceptance uses a random in-memory password, then LOCKS the
admin account. You must set your own password before normal browser access.

## Validation and persistence

`sudo python3 scripts/test-nginx-admin.py` runs isolated proxy checks on the
Nginx host using its existing certificate and a synthetic backend. It checks
TLS, authentication, route isolation, Host/Origin/fetch rejection and header
stripping without provider access. `--live-bootstrap --gateway-ip <nginx-ip>`
is a one-time installation acceptance operation: it refuses to replace an
existing htpasswd file, validates real read-only APIs, and locks the account
afterward. Never use this bootstrap option for routine password rotation.

Verify raw management succeeds from Nginx but fails from an ordinary LAN host.
Verify inference health remains ok/fallback_token=set/collapse_system_enabled=true.
Record selection/Tested hashes before and after recreation. Do not run inference
or mutate selections for proxy acceptance.

Nginx and Docker are enabled host services; Compose gateway restart is
unless-stopped. The settings/auth volumes remain unchanged. Reboot persistence
is validated by startup ordering/rules inspection, not by rebooting shared hosts.

## Retired Caddy state

The old sidecar, namespace coupling, HTTPS host-port publication, secret mounts
and bootstrap helpers are removed from active Compose. Remove only the old
sidecar container after replacement acceptance; do not prune volumes.
Retain the old Caddy data/config volumes temporarily. After manual browser
acceptance, those two unused volumes can be deleted explicitly if rollback to
Caddy is no longer needed. Never remove gateway auth/settings volumes.
