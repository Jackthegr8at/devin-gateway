---
goal: Replace Caddy with the existing authenticated internal Nginx
version: 1
date_created: 2026-10-04
last_updated: 2026-10-04
owner: maintainers
status: Completed
tags: [infrastructure, security]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the reviewed Nginx topology; retain Caddy until replacement acceptance.

## 1. Requirements & Constraints

- REQ-001: Reuse wildcard TLS and existing LAN/WireGuard allowlists; add site-only Basic authentication.
- SEC-001: Strip browser credentials, validate Host/Origin/fetch metadata and retain backend CSRF checks.
- SEC-002: Publish management only on private host IPv4; persistent Docker-aware source restriction permits only Nginx.
- CON-001: Preserve inference, auth/settings volumes, model selection and Desktop tooling. No inference.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Stage and validate before retirement.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Audit existing Nginx certificate, ACL, logs, auth utility and Docker startup firewall. | yes | 2026-10-04 |
| TASK-002 | Add deploy/nginx-devin-admin.conf and scripts/devin-admin-firewall.sh; install persistent deny before publishing. | yes | 2026-10-04 |
| TASK-003 | Validate proxy with synthetic in-memory authentication and header-checking backend; validate actual UI, API, firewall and preserved state. | yes | 2026-10-04 |

### Implementation Phase 2

- GOAL-002: Retire Caddy after acceptance.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Update Compose/docs/tests, remove obsolete Caddy helpers; preserve state volumes on host. | yes | 2026-10-04 |
| TASK-005 | Deploy final Compose, confirm restart settings and unchanged saved-state hashes; retain Caddy volumes. | yes | 2026-10-04 |

## 3. Alternatives

- ALT-001: Caddy sidecar rejected in favor of established Nginx infrastructure.
- ALT-002: Loopback host publication cannot be reached by a separate Nginx host.

## 4. Dependencies

- DEP-001: Existing Nginx, wildcard certificate, htpasswd, Docker, iptables and Docker ExecStartPost hook.

## 5. Files

- FILE-001: Compose, deployment templates, proxy/firewall tests and operational documentation.

## 6. Testing

- TEST-001: Exact route, Host/Origin/fetch rejection, authentication, ACL, upstream header stripping.
- TEST-002: Nginx-source connectivity and other-LAN denial; unchanged inference health.
- TEST-003: Auth/settings hashes unchanged; Nginx syntax and firewall shell syntax; relevant Bun checks.

## 7. Risks & Assumptions

- RISK-001: Docker bypasses ordinary UFW INPUT; original-destination DOCKER-USER matching is mandatory.
- RISK-002: Gateway recreation interrupts in-flight requests; no inference is performed during migration.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Existing Nginx lacked Basic authentication; user approved site-specific hash-only storage.
- NOTE-002: Live read-only acceptance returned selection revision 30 and Tested revision 16; both file hashes remained unchanged across recreation.
- NOTE-003: Auth directory root:www-data 0750; htpasswd file root:www-data 0640. Account locked after synthetic acceptance pending operator password setup.
- NOTE-004: Nginx source reached raw management (200); Windows LAN connection timed out; trusted Windows HTTPS returned authentication challenge (401).
- NOTE-005: Required pre-Docker oneshot and raw PREROUTING restriction prevent startup exposure; ordering, syntax and idempotent application verified without rebooting shared hosts.
- NOTE-006: 547 offline Bun tests passed, 18 skipped, one known Windows SIGTERM failure. Known discovery-deadline stall excluded. Typechecks/build/diff and 35 fingerprint checks passed; no source/runtime changes.

## 9. Related Specifications / Further Reading

- [Docker packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
- [Nginx Basic authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)
