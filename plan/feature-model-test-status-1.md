---
goal: Persist conservative runtime model validation independently of selection
version: 1
date_created: 2026-10-02
status: Completed
tags: [feature, models, diagnostics]
---

# Introduction

Record safe routing evidence and expose exact-variant test status without changing inference or selection.

## 1. Requirements & Constraints

- REQ-001: Separate private atomic model-test-status.json; no historical inference or profile-based seed.
- SEC-001: IDs, booleans and statuses only; never persist input/output, token or instruction content.
- CON-001: Preserve routing, collapse, catalogs, selection revision, OAuth and activation.
- PAT-001: Management Host/Origin/header protections and existing settings volume.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Storage and in-process correlated evidence.

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | Add src/admin/model-test-status.ts private store and bounded runtime correlation | Yes | 2026-10-02 |
| TASK-002 | Extend src/responses-diagnostics.ts with emitted/returned evidence and finalization observer | Yes | 2026-10-02 |
| TASK-003 | Integrate src/server.ts without changing Responses results | Yes | 2026-10-02 |

### Implementation Phase 2

- GOAL-002: Management actions, compact UI, verification and deployment.

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-004 | Add protected status API and persistent badges/manual controls | Yes | 2026-10-02 |
| TASK-005 | Add offline persistence, correlation, API, UI and redaction tests | Yes | 2026-10-02 |
| TASK-006 | Run full suites, refresh canonical fingerprint and review release handoff | Yes | 2026-10-02 |

## 3. Alternatives

- ALT-001: JSONL polling rejected; evidence exists in process.
- ALT-002: HTTP 200 or replayed history rejected as insufficient evidence.

## 4. Dependencies

- DEP-001: Existing settings directory and management listener; no new packages.

## 5. Files

- FILE-001: src/admin/model-test-status.ts, routes.ts, model-catalog.ts.
- FILE-002: src/responses-diagnostics.ts, server.ts.
- FILE-003: web/model-picker API, row, picker, types and styles.
- FILE-004: Focused tests, operator documentation and reviewed fingerprint pin.

## 6. Testing

- TEST-001: Empty initialization, private atomic writes, corruption rejection, restart, manual provenance, revision independence.
- TEST-002: Exact credential/model/effort/call-ID correlation; text-only, failed, unknown result and replay do not qualify.
- TEST-003: Successful explicit local exit status and completed continuation qualify; later transient failure does not clear status.
- TEST-004: Host/Origin/header protection, family UI, unsaved draft preservation and full established suites.

## 7. Risks & Assumptions

- RISK-001: Responses tool output has no universal success field. Recognize only explicit successful structured status or completed local exec zero-exit envelopes; opaque outputs remain untested.
- RISK-002: Pending issued-call metadata is bounded, credential-scoped and memory-only; restart loses pending calls, not saved status.
- ASSUMPTION-001: Manual overrides are authoritative and stored separately from automatic evidence.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Routing fields already exist. Hard-coded profile-derived tested badges must be replaced, not used to seed status.
- NOTE-002: Offline result: 441 passed, 18 skipped, one documented upstream Windows SIGTERM baseline failure. All seven PowerShell suites, typechecks, build, fingerprint and privacy checks passed. Authorized commit/push/deploy follows the completed implementation review; no inference is part of deployment acceptance.

## 9. Related Specifications / Further Reading

- tools/codex-devin/README.md
