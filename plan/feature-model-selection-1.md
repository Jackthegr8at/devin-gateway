---
goal: Backend-only Devin model-selection foundation
version: 1
date_created: 2026-10-01
last_updated: 2026-10-01
status: Completed
tags: [feature, codex, security]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Implement the approved backend foundation without UI or PowerShell activation changes. Follow-up Phase 1 acceptance authorizes gateway-only deployment, configuration/discovery checks, the reviewed fingerprint pin update and a local commit; no OAuth, inference, Desktop launch or push.

## 1. Requirements & Constraints

- REQ-001: Exact-ID profiles only for GLM Low and SWE-2 Medium; never infer effort from names.
- REQ-002: Strict version-1 selection, private atomic storage, optimistic revisions, and unavailable-model preservation.
- SEC-001: Separate settings/auth directories and volumes; never export credentials, instructions, scripts, or permissions.
- SEC-002: Management routes must not inherit inference CORS or raw tracing; default to loopback, and publish the explicit container listener only on host loopback.
- CON-001: Preserve inference behavior, collapse allowlist, model routing, and all guarded Windows tooling.
- CON-002: Acceptance may recreate only the gateway on the existing private Docker stack; preserve auth credentials/volumes and inference port. Do not perform OAuth or inference.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Define and verify the backend domain and persistence layer.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add src/admin/codex-model-profiles.ts with immutable exact-ID reviewed efforts. | Yes | 2026-10-01 |
| TASK-002 | Add src/admin/model-selection.ts with strict schema, seeded roles, and ETag validation. | Yes | 2026-10-01 |
| TASK-003 | Add src/admin/model-selection-store.ts with private atomic writes, serialized cross-instance locking and revisions. | Yes | 2026-10-01 |
| TASK-004 | Extend src/devin.ts with opt-in discovery details while retaining legacy discovery and /v1/models response behavior. | Yes | 2026-10-01 |

### Implementation Phase 2

- GOAL-002: Integrate the backend routes and separate Docker settings storage.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add src/admin/model-catalog.ts and routes.ts for sanitized admin discovery, selection, and read-only Codex manifests. | Yes | 2026-10-01 |
| TASK-006 | Integrate src/server.ts using disabled-by-default selection and an optional loopback management listener. | Yes | 2026-10-01 |
| TASK-007 | Add Docker settings volume and unprivileged writable directory without altering auth volume/login flow. | Yes | 2026-10-01 |
| TASK-008 | Add focused domain/store/discovery/HTTP/Docker tests and operator documentation; run offline suite, typecheck, build and diff checks. | Yes | 2026-10-01 |

## 3. Alternatives

- ALT-001: Reject suffix-derived reasoning arrays because discovery does not establish supported efforts.
- ALT-002: Reject management writes on the inference listener because its legacy CORS is deliberately permissive.
- ALT-003: Reject shared credential/settings storage; separate lifecycles and paths are required.

## 4. Dependencies

- DEP-001: Existing Bun HTTP server, node filesystem primitives, and Devin discovery protobuf decoder; no new dependency.
- DEP-002: Phase 2 UI and later Windows integration consume this foundation but are not implemented here.

## 5. Files

- FILE-001: src/admin/*.ts, src/devin.ts, src/server.ts.
- FILE-002: Dockerfile, docker-entrypoint.sh, docker-compose.yml, README.md.
- FILE-003: test/model-selection*.test.ts and discovery regression tests.

## 6. Testing

- TEST-001: Exact efforts/IDs, strict schema, roles, unknown enabled models and future policy.
- TEST-002: Initial migration, corrupt files, atomic replacement, concurrency, private permissions, cross-instance recreation persistence.
- TEST-003: Removed models, upstream-vs-fallback provenance and no invented reasoning.
- TEST-004: Loopback management isolation, Host/Origin/content-type/body bounds, ETags, safe exports and unchanged inference endpoints.
- TEST-005: Docker volume separation, full offline Bun tests, TypeScript checks, production build and diff whitespace checks.

## 7. Risks & Assumptions

- RISK-001: Discovery presence is not proof of remote callability; only the two reviewed models are eligible for roles/export.
- RISK-002: A crashed writer can leave a lock; fail closed with a bounded timeout, never steal a possibly active lock.
- ASSUMPTION-001: One gateway writer per named settings volume is the normal deployment; lock/revision checks also protect accidental concurrent writers.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Existing discovery uses fallback limits and a label-based reasoning boolean; admin metadata must distinguish both from upstream fields.
- NOTE-002: Docker recreation verification is conditional on a usable local Docker daemon; filesystem recreation tests do not prove a live container restart.
- NOTE-003: Focused model-selection suite: 32 passed, 1 POSIX-only test skipped on Windows. Full offline suite: 345 passed, 18 skipped, 1 known baseline Windows SIGTERM graceful-shutdown failure. Typecheck, production build, shell syntax and git diff --check passed.
- NOTE-004: Existing offline PowerShell collapse guards, home, process identity, recovery and recovery-workflow tests passed without editing activation tooling or active configuration.
- NOTE-005: Follow-up acceptance verified actual Docker recreation and gateway-owned Linux 0700/0600 storage. The initial revision-1 file retained SHA-256 ce5a152ab9649cb97cba060ea57866a8687319105caf5395dccf72603ddba537 across gateway-only recreation. Auth/settings volumes were never removed.
- NOTE-006: The approved final runtime review refreshed only the Windows launcher fingerprint pin to F68C1862EE4DCDF84FFB12751F09C966424C6AD158737C320D5681AD461C3B4B. All 30 canonical fingerprint checks pass; the algorithm and mismatch guards are unchanged.
- NOTE-007: Management binds 0.0.0.0:3001 inside Docker and is published only at host 127.0.0.1:38644. Host/Origin guards accept only exact loopback authorities at listener/published ports. LAN access was rejected from the Linux host and a separate Windows machine; inference port/auth behavior remains unchanged.
- NOTE-008: Actual configuration/discovery acceptance returned 260 discovered models and exactly two reviewed Codex profiles. Synthetic update succeeded (200), stale ETag failed (412), invalid/unvalidated roles failed (400). Original two-model settings were restored through the API at revision 3; revisions were not reset.
- NOTE-009: Final Windows suite: 346 passed, 18 skipped, one known baseline SIGTERM failure. Complete offline Linux suite in a disposable network-isolated, no-auth-volume container: 348 passed, 17 gated live tests skipped, zero failures. All six PowerShell suites, typecheck, production build, shell syntax, diff checks and privacy review passed. No real OAuth or inference request was made.
- NOTE-010: Docker's default build network stalled on package retrieval; the same Dockerfile built successfully with host networking for the build only. Runtime networking, other services and auth storage were not changed.

## 9. Related Specifications / Further Reading

- README.md: existing Codex Desktop, auth-volume and guarded Windows operator workflow.
- Approved design report and Phase 1 scope in the current task.
