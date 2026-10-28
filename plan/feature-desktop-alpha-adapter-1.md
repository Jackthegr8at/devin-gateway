---
goal: Add the approved exact Desktop alpha adapter without inference changes
version: 1
date_created: 2026-10-03
status: Completed
tags: [codex, provenance, tests]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the approved exact-version extension to the existing local catalog adapter.

## 1. Requirements & Constraints

- REQ-001: Recognize exactly 0.159.2 and 0.159.0-alpha.12.1.
- SEC-001: Source instructions locally; pin 18043 UTF-8 bytes and the existing reviewed hash. Never store the body in Git or output.
- CON-001: Keep Devin V1/shell metadata, efforts, recovery and diagnostics unchanged.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Extend exact records, validate and publish local tooling only.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Inspect actual bundled catalog in memory; compare structure and unique instruction hash. | Yes | 2026-10-03 |
| TASK-002 | Add exact record/map and matching PowerShell adapter selection. | Yes | 2026-10-03 |
| TASK-003 | Run real isolated catalog/restore tests, synthetic rejection tests and complete offline suites; refresh reviewed pin. | Yes | 2026-10-03 |
| TASK-004 | Publish approved adapter on feature branch; no server deployment is required. | Yes | 2026-10-03 |

## 3. Alternatives

- ALT-001: Wildcards, nearest-version fallback and bundled V2 defaults rejected.

## 4. Dependencies

- DEP-001: Installed versioned Desktop backend and existing Bun/PowerShell harness.

## 5. Files

- FILE-001: CodexSelection.ts, CodexDevin.Selection.ps1, new provenance JSON, tests, documentation and reviewed launcher pin.

## 6. Testing

- TEST-001: Actual backend accepts generated models/efforts/V1/shell in an isolated home; config/worker restore hashes match.
- TEST-002: Unknown version, mismatched record, wrong/missing/duplicate instructions and unsupported root structures reject.

## 7. Risks & Assumptions

- RISK-001: Offline acceptance is not live worker validation; user performs inference separately.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Current backend has the reviewed instruction block exactly once, but bundled model defaults include V2/unified execution, which are intentionally not imported.
- NOTE-002: Actual isolated backend accepts generated models and exact low/medium efforts; generated metadata remains V1/shell_command. Effective debug models normalizes shell_type to unified_exec while retaining V1. No feature override or inference was attempted.
- NOTE-003: Full offline suite: 447 pass, 18 skip and the documented Windows SIGTERM failure. Typechecks/build and all seven PowerShell suites pass, including byte-exact existing-worker and interrupted restoration. No active Codex state or server code changed.
- NOTE-004: Approved offline investigation: replacing shell_command with unified_exec only in the disposable generated catalog produces an identical complete effective catalog. Disabled remains disabled. Original catalog hash and provider/security config hash remain exact after the probe; selection/recovery suite now has 67 passing assertions.
- NOTE-005: Cached Codex source at 8e68a98ef03cdde76d2e6800791ebdf1b3b95b24 explicitly declares shell_command as a serde alias of ConfigShellToolType::UnifiedExec (protocol/src/openai_models.rs:315) and tests its canonical serialization (line 1042). This cache is not claimed to be the exact alpha binary source; the installed alpha comparison independently verifies the alias behavior.
- NOTE-006: Gateway checks shell_command only in input compatibility metadata/catalog generation, not in effective backend output. Responses forwarding depends on the actual exec_command declaration and does not execute commands or forward write_stdin. Backend feature/permission policy governs resumable versus one-shot execution separately from this alias.
- NOTE-007: Reviewed 0.159.2 provenance stores generated shell_command metadata but no effective-catalog capture proves its canonical value. No other runtime was installed/run. The user approved publication after reviewing the alias findings. The generated metadata and deployed diagnostics remain unchanged; no gateway rebuild is required.

## 9. Related Specifications / Further Reading

- [Runtime provenance](../tools/codex-devin/templates/README.md)
