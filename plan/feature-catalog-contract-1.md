---
goal: Replace backend-version membership with an offline catalog compatibility contract
version: 1
date_created: 2026-10-03
status: Completed
tags: [codex, compatibility, privacy]
---

# Introduction

Implement the user-approved contract without accepting changed instruction content.

## 1. Requirements & Constraints

- REQ-001: Any detected backend version must satisfy contract version 1 before activation.
- SEC-001: Exactly one runtime-local instruction body must match the unchanged reviewed hash and byte length; never print or commit that body.
- CON-001: No inference, OAuth, active-home mutation, merge, deployment, or model-test-status changes.
- REQ-002: Preserve managed executable guards, bounded execution, fresh backups and byte-exact recovery.

## 2. Implementation Steps

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | Replace version records with one contract record in CodexSelection.ts and templates | Yes | 2026-10-03 |
| TASK-002 | Probe generated catalogs in an isolated home and validate exact model/effort/V1/shell metadata | Yes | 2026-10-03 |
| TASK-003 | Record contract/version/executable provenance and invoke probe before Enable mutation | Yes | 2026-10-03 |
| TASK-004 | Update synthetic tests and run all isolated checks against installed backend | Yes | 2026-10-03 |

## 3. Alternatives

- ALT-001: Another exact-version entry was explicitly rejected.
- ALT-002: Generic changed-content selection is deferred; no fuzzy instruction matching.

## 4. Dependencies

- DEP-001: Existing installed managed backend, Bun, isolated debug-models command and reviewed shell alias.

## 5. Files

- FILE-001: tools/codex-devin/CodexSelection.ts, CodexDevin.Selection.ps1, Enable-CodexDevin.ps1, templates and tests.

## 6. Testing

- TEST-001: Compatible unknown release accepted; missing/ambiguous instruction anchor rejected.
- TEST-002: Catalog rejection, changed ID/effort/V1/field types/shell rejected.
- TEST-003: shell_command/unified_exec complete effective equality; disabled stays disabled.
- TEST-004: Isolated provider/security/role and recovery/hash suites; full Bun/typecheck/build/privacy/fingerprint checks.

## 7. Risks & Assumptions

- RISK-001: Offline catalog acceptance does not establish new inference/provider behavior.
- ASSUMPTION-001: Existing reviewed instruction provenance remains authoritative independent of release version.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Installed 0.160.0 passes without a version entry. The existing anchor remains unique; four logical models and seven concrete efforts pass the offline backend contract.
- NOTE-002: Full Bun: 452 pass, 18 skip, one documented upstream Windows SIGTERM failure. Focused compatibility/adapter: 99 pass. Seven PowerShell suites pass, including 77 selection checks. Typechecks/build, 15 script syntax checks, privacy and diff checks pass.
- NOTE-003: No runtime instruction body enters Git or diagnostics; synthetic fixtures only. No live inference, OAuth, active-home mutation or status-state mutation. No denylist is needed.
- NOTE-004: Generated catalog and worker/config probe files are disposable and removed in finally blocks. Contract verifies parsing and byte invariants offline, not live native-agent execution for new backend releases.

## 9. Related Specifications / Further Reading

- tools/codex-devin/templates/README.md documents contract/provenance and semantic alias policy.
