---
goal: Retain safe opaque normalized call identity without loosening log identifiers
version: 1
date_created: 2026-10-03
status: Completed
tags: [diagnostics, correlation, privacy]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the approved separation of exact internal bridge identity from diagnostic rendering.

## 1. Requirements & Constraints

- REQ-001: Preserve exact normalized call identity across completed emission and returned output.
- SEC-001: No raw call ID in JSONL. Keep display regex and credential/privacy protections separate.
- CON-001: Do not modify bridge parsing, emission, routing, tool forcing, adapter or promotion criteria.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Validate internal opaque IDs, test and publish only the feature branch.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | responses-diagnostics.ts: dedicated opaque identity validator, byte budget, fixed privacy reasons, name-only tool summaries. | Yes | 2026-10-03 |
| TASK-002 | Offline JSON/SSE High A/B regression; bound, controls, exact spelling, provider punctuation and privacy tests. | Yes | 2026-10-03 |
| TASK-003 | Validate full suites and publish the approved gateway fix on the feature branch only. | Yes | 2026-10-03 |

## 3. Alternatives

- ALT-001: Widen shared display regex: rejected because unrelated fields must stay strict.
- ALT-002: Rewrite IDs: rejected because continuation requires exact identity.

## 4. Dependencies

- DEP-001: Existing normalized bridge objects and strict credential/model/effort/call correlation.

## 5. Files

- FILE-001: responses-diagnostics.ts; diagnostic/status/server tests; operator notes; reviewed launcher pin.

## 6. Testing

- TEST-001: Synthetic known SWE-style usage/thinking/toolcall/done, followed by matching successful output, promotes exact High variant only in isolated test state.
- TEST-002: Exact-match dimensions and manual precedence remain covered; raw content and IDs never enter safe JSONL.
- TEST-003: Long/punctuation IDs pass; blank/non-string/control/invalid Unicode/over-budget IDs reject.

## 7. Risks & Assumptions

- RISK-001: 4096 UTF-8 bytes is an operational budget, not a protocol maximum. Existing 1024 pending entries cap ID payload near 4 MiB plus runtime overhead.
- ASSUMPTION-001: Exact live SWE spelling is not available in safe logs; fixtures use known protobuf shapes with synthetic opaque identities, not claimed captured IDs.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Live stage diagnostics establish invalid_format after completed Responses emission and before evidence retention; they do not reveal the offending character/length.
- NOTE-002: Focused suite 64 pass; full offline suite 449 pass, 18 skip and only the documented Windows SIGTERM baseline failure. All seven PowerShell suites, typechecks/build, syntax and diff checks pass. High A/B JSON/SSE tests preserve exact Responses ID and establish matching evidence without raw ID logging.

## 9. Related Specifications / Further Reading

- [Operator notes](../tools/codex-devin/MODEL_TEST_STATUS.md)
