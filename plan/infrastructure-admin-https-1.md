---
goal: Permanent authenticated HTTPS access to the existing management picker
version: 1
date_created: 2026-10-04
last_updated: 2026-10-04
owner: Gateway maintainers
status: Deprecated
tags: [infrastructure, security]
---

# Introduction

![Status: Deprecated](https://img.shields.io/badge/status-Deprecated-red)

Historical implementation record, superseded by [the Nginx migration](infrastructure-nginx-admin-1.md). Do not use this retired topology or its commands for current deployment.

## 1. Requirements & Constraints

- **REQ-001**: HTTPS admin hostname is devin-admin.home.arpa; DNS is user-managed.
- **SEC-001**: Validate external Host/Origin/fetch metadata before loopback translation; authenticate every allowed resource.
- **SEC-002**: Gateway management binds 127.0.0.1:3001 with no host publication. Strip browser credentials upstream.
- **CON-001**: Preserve inference port 38643, auth/settings volumes, model state and Desktop activation.
- **CON-002**: No live inference, OAuth, public DNS or Windows configuration mutations.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Validate namespace semantics and implement the approved proxy contract.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Verify Compose v2.20.2 accepts service namespace sharing with HTTPS ports on the gateway owner. | yes | 2026-10-04 |
| TASK-002 | Modify docker-compose.yml: loopback admin, Caddy sidecar, private HTTPS bind and separate state volumes. | yes | 2026-10-04 |
| TASK-003 | Add deploy/Caddyfile: exact resources, validation, Basic auth, TLS and stripped credentials. | yes | 2026-10-04 |
| TASK-004 | Modify web/model-picker/api.ts and frontend tests for same-origin browser auth only. | yes | 2026-10-04 |
| TASK-005 | Add scripts/test-admin-proxy.py and test/admin-proxy.test.ts for isolated proxy checks. | yes | 2026-10-04 |

### Implementation Phase 2

- GOAL-002: Validate, publish and deploy without changing saved state.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Document secret generation/rotation, certificate trust, restart/recreation and browser acceptance. | yes | 2026-10-04 |
| TASK-007 | Run offline tests/build and disposable Docker proxy/Compose validation. | yes | 2026-10-04 |
| TASK-008 | Commit/push codex-desktop, deploy gateway plus Caddy, verify private binds and saved-state hashes. | yes | 2026-10-04 |

## 3. Alternatives

- **ALT-001**: Host Caddy targeting the published admin port retains a container-wide management bind; rejected by the approved loopback requirement.
- **ALT-002**: Application login/SSO duplicates responsibilities; Basic auth is sufficient here.

## 4. Dependencies

- **DEP-001**: Official Caddy 2.10.2-alpine image, verified available with Docker.
- **DEP-002**: Private Basic-auth hash file and approved client CIDRs; user approval required for generated bootstrap credentials.

## 5. Files

- **FILE-001**: docker-compose.yml, deploy/Caddyfile, devhub.env.example, ignore files.
- **FILE-002**: web/model-picker/api.ts and test/model-picker-api.test.ts.
- **FILE-003**: scripts/test-admin-proxy.py, test/admin-proxy.test.ts, test/model-selection-docker.test.ts.
- **FILE-004**: deploy/ADMIN_HTTPS.md and README.md.

## 6. Testing

- **TEST-001**: Disposable Linux Docker proxy verifies exact paths, Host/Origin/fetch metadata, auth and credential removal.
- **TEST-002**: Bun frontend/backend security tests, typechecks, build, privacy and diff checks.
- **TEST-003**: Deployment checks use GET only and compare settings/status hashes; no inference.

## 7. Risks & Assumptions

- **RISK-001**: Namespace owner recreation requires sidecar recreation; Compose-managed dependency restart is retained.
- **RISK-002**: Internal CA root must be trusted on Windows; never export its key.
- **ASSUMPTION-001**: User configures hostname resolution separately.

## 8. Audit Findings / Notes (Optional)

- **NOTE-001**: Port publication must be on devin-gateway, not the namespace-sharing proxy.
- **NOTE-002**: Gateway backend guards remain unchanged; only the browser API credential mode changes.
- **NOTE-003**: 546 Bun tests passed, 18 skipped; existing discovery-deadline stall and Windows SIGTERM baseline excluded. Typechecks/build/fingerprint passed; 36 disposable Linux proxy/bootstrap checks passed.
- **NOTE-004**: Implementation commit 39daad2 deployed. GET-only verified-TLS acceptance passed, including authentication, route/Host/Origin rejection, raw-port removal and internal loopback binding. Selection revision 30 and Tested revision 16 survived byte-for-byte; both gateway volumes retained. No inference or OAuth ran. User DNS, Windows CA trust and visual browser acceptance remain manual.
- **NOTE-005**: Build retried with host networking for package downloads only; runtime namespace/ports unchanged. Both services have persistent state and automatic restart policies; Docker restart and host reboot were not performed against unrelated services.

## 9. Related Specifications / Further Reading

- [Approved operational state](../tools/codex-devin/MULTI_AGENT_LIFECYCLE.md)
- [Docker network modes](https://docs.docker.com/reference/compose-file/services/#network_mode)
- [Caddy Basic auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
