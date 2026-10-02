---
goal: Restore trusted structured routing and two-request Tested evidence without weakening redaction
version: 1
date_created: 2026-10-02
status: Completed
tags: [bug, diagnostics, security]
---

# Introduction

Approved narrow follow-up to the model-test-status feature. The original redactor rejected valid IDs mentioned inside Desktop prompts/history/schema text. Keep conservative handling for arbitrary trace fields; isolate validated bridge identifiers from credential material.

## 1. Requirements & Constraints

- REQ-001: Preserve normalized emitted call and normalized returned tool-message evidence.
- SEC-001: Credential overlap remains redacted; no raw content enters JSONL or status storage.
- CON-001: No routing, collapse, activation, selection, or inference behavior change.
- CON-002: Deploy only the feature branch; no inference or retroactive status promotion.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Implement approved structured-field boundary.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Separate credential registration from sensitive-text registration in src/responses-diagnostics.ts; retain conservative untrusted methods. | Yes | 2026-10-02 |
| TASK-002 | Use resolved routing, finished accumulator calls, and converted tool messages in src/server.ts. | Yes | 2026-10-02 |
| TASK-003 | Test real two-request sequence and all four correlation tuple components with synthetic offline fixtures. | Yes | 2026-10-02 |
| TASK-004 | Run full established offline checks and refresh canonical reviewed fingerprint; hand off to authorized feature-branch commit/push/deployment. | Yes | 2026-10-02 |

## 3. Alternatives

- ALT-001: Remove sensitive-text checks globally: rejected because arbitrary trace values could leak content.
- ALT-002: Parse raw request text or JSONL: rejected because the existing bridge already validates structured objects.

## 4. Dependencies

- DEP-001: Existing Responses converter, completed tool accumulator, and bounded ModelValidationTracker.

## 5. Files

- FILE-001: src/responses-diagnostics.ts and src/server.ts.
- FILE-002: test/model-test-status.test.ts and test/server.test.ts.
- FILE-003: tools/codex-devin/Start-DevinGateway.ps1 reviewed fingerprint only.

## 6. Testing

- TEST-001: IDs embedded in Desktop content retained only by structured paths; credentials and arbitrary trace strings rejected.
- TEST-002: A usage/thinking/toolcall/done and B usage/thinking/text/done produce safe booleans and exact-variant promotion.
- TEST-003: Cross-model, effort, scope, call-ID, failed/text-only continuation cannot promote; manual override remains authoritative.
- TEST-004: Full offline Bun/PowerShell/typecheck/build/privacy/fingerprint checks; no live inference.

## 7. Risks & Assumptions

- RISK-001: Only trusted bridge call sites may use structured methods; tests and source review enforce this boundary.
- ASSUMPTION-001: Credential scope plus provider call ID, variant, and effort identify one issued-call continuation.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: safeTraceId previously rejected candidate IDs when any sensitive text contained them.
- NOTE-002: Focused regressions: 59 passed. Full offline suite: 443 passed, 18 skipped, only the documented upstream Windows SIGTERM baseline failure. All seven PowerShell suites, three TypeScript checks, production build, privacy scan and diff check passed. No inference or OAuth ran.

## 9. Related Specifications / Further Reading

- [Existing feature plan](feature-model-test-status-1.md)
- [Status operator notes](../tools/codex-devin/MODEL_TEST_STATUS.md)
