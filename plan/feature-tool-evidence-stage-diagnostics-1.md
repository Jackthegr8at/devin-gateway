---
goal: Observe tool-call recognition boundaries without changing inference or Tested semantics
version: 1
date_created: 2026-10-02
status: In progress
tags: [diagnostics, security, tests]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Approved diagnostic-first investigation of a completed upstream toolcall without recognized Tested evidence. No routing or tool forcing changes.

## 1. Requirements & Constraints

- REQ-001: Report fixed modes/counts for request structure, decoded calls, Responses emission, evidence and correlation.
- SEC-001: Rejection records contain only fixed stage/field/state/reason and overlap boolean; never rejected values.
- CON-001: Preserve promotion eligibility, manual precedence, routing, collapse, credential handling and selection revision.
- CON-002: No inference, Desktop restart or status modification during deployment.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Add safe observations at existing bridge boundaries.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | src/responses-diagnostics.ts: fixed choice/input counters and bounded identifier stage records. | Yes | 2026-10-02 |
| TASK-002 | src/server.ts: observe decoded calls, existing accumulator branches and Responses item emission. | Yes | 2026-10-02 |
| TASK-003 | src/admin/model-test-status.ts: annotate existing correlation decisions with fixed counters only. | Yes | 2026-10-02 |
| TASK-004 | Offline JSON/SSE tests: common GLM/SWE auto/required/specific contract, successful two-request flow and rejected identifier boundary. | Yes | 2026-10-02 |
| TASK-005 | Full established checks, canonical fingerprint review and authorized feature-branch deployment. | No | |

## 3. Alternatives

- ALT-001: Force tools in production: rejected; current live evidence does not establish a forcing defect.
- ALT-002: Log rejected values or raw payloads: rejected for privacy and credential safety.

## 4. Dependencies

- DEP-001: Existing Responses conversion, accumulator, Devin protobuf fixtures and validation tracker.

## 5. Files

- FILE-001: src/responses-diagnostics.ts, src/server.ts, src/admin/model-test-status.ts.
- FILE-002: test/server.test.ts, test/responses-diagnostics.test.ts, test/model-test-status.test.ts.
- FILE-003: tools/codex-devin/MODEL_TEST_STATUS.md and reviewed launcher fingerprint.

## 6. Testing

- TEST-001: Equivalent GLM/SWE logical requests preserve exact tool choice, schemas and disabled parallel calls on the wire.
- TEST-002: Existing usage/thinking/toolcall/done protobuf fixture emits a Responses call and supports successful matching continuation.
- TEST-003: Nonempty long IDs accepted by the bridge but rejected by existing diagnostic limits are observable without logging the ID or altering behavior.
- TEST-004: Safe rejection and correlation reasons; no raw content; full offline checks.

## 7. Risks & Assumptions

- RISK-001: A synthetic boundary reproduction is not proof of the live SWE cause; manual acceptance must establish the actual first disappearing stage.
- ASSUMPTION-001: Decoded object counts include follow-up deltas; completed and emitted counts describe consolidated calls.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: The existing Responses bridge accepts nonempty call IDs which the diagnostic 128-character/format/secret checks may reject. This work observes but does not change that boundary.
- NOTE-002: Validation: 62 focused tests pass; full offline suite has 446 pass, 18 skip and the documented Windows SIGTERM baseline failure. Three TypeScript checks, production build, PowerShell AST, six guard/recovery/fingerprint suites and changed-file privacy scan pass.
- NOTE-003: The unchanged selection suite is environmentally blocked: its adapter requires 0.159.2, while the installed versioned Desktop backend reports 0.159.0-alpha.12.1. This diff does not modify discovery, version handling, catalog generation, selection switching/persistence or runtime templates. The user approved deployment with this limitation recorded; no assertions or guards are bypassed.

## 9. Related Specifications / Further Reading

- [Status operator notes](../tools/codex-devin/MODEL_TEST_STATUS.md)
- [Correlation fix](feature-model-test-status-correlation-1.md)
