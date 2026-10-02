---
goal: Dynamic guarded Desktop activation from the saved gateway selection
version: 1
date_created: 2026-10-01
last_updated: 2026-10-01
owner: gateway maintainers
status: Completed
tags: [feature, codex, windows]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the approved Phase 3 specification without changing inference, family routing, authentication, or the picker.

## 1. Requirements & Constraints

- REQ-001: Fetch and strictly validate schema-v2 selection after health/auth and before changing Codex files; never substitute defaults.
- REQ-002: Generate deterministic catalogs from reviewed profiles and the matching instruction value extracted from the installed runtime's bundled catalog, verified against a pinned hash and UTF-8 length.
- SEC-001: Accept no executable content, instructions, or security configuration from the gateway.
- CON-001: Preserve exact backups/restoration and all existing process, reparse, fingerprint, local/remote and auth guards.
- CON-002: Offline validation only; no deployment, Desktop launch, inference, or commits.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Validate selection and generate trusted catalogs.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add strict manifest validation and deterministic catalog generation in tools/codex-devin/CodexSelection.ts. | ✅ | 2026-10-01 |
| TASK-002 | Add a small 0.159.2 metadata/provenance record with an instruction hash and length; keep the runtime instruction body out of the repository. | ✅ | 2026-10-01 |

### Implementation Phase 2

- GOAL-002: Integrate guarded activation and per-run integrity records.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add bounded manifest/runtime preparation in CodexDevin.Selection.ps1. | ✅ | 2026-10-01 |
| TASK-004 | Update Enable-CodexDevin.ps1 to generate per-run catalog and explicit role efforts. | ✅ | 2026-10-01 |
| TASK-005 | Remove fixed-model preflight assumptions from Run-CodexDevinCollapseTest.ps1. | ✅ | 2026-10-01 |
| TASK-006 | Extend canonical fingerprint inputs and update reviewed pin after review. | ✅ | 2026-10-01 |

### Implementation Phase 3

- GOAL-003: Verify offline fail-closed behavior and recovery.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Add manifest/catalog tests and PowerShell selection/activation/recovery tests. | ✅ | 2026-10-01 |
| TASK-008 | Run bounded full offline suites, typecheck, build, privacy and diff checks; document blockers. | ✅ | 2026-10-01 |

## 3. Alternatives

- ALT-001: Keeping the fixed catalog pin was rejected because it cannot represent saved role choices.
- ALT-002: Downloading gateway instructions was rejected because instruction trust belongs to the local runtime adapter.

## 4. Dependencies

- DEP-001: Existing schema-v2 codex-selection endpoint and exact-ID profile registry.
- DEP-002: Bundled Desktop 0.159.2 and Bun already used by the tooling.

## 5. Files

- FILE-001: tools/codex-devin/CodexSelection.ts and the versioned runtime metadata record.
- FILE-002: tools/codex-devin/CodexDevin.Selection.ps1 and activation/wrapper/fingerprint files.
- FILE-003: test/codex-selection.test.ts and focused PowerShell tests.

## 6. Testing

- TEST-001: Strict schema, roles, metadata, duplicate IDs, effort validation and deterministic bytes.
- TEST-002: Bounded failures before file mutation, local/remote parity, interrupted and byte-for-byte restoration.
- TEST-003: Existing full offline compatibility, fingerprint, process, recovery, typecheck and build suites.

## 7. Risks & Assumptions

- RISK-001: Unknown runtime versions must fail closed rather than inherit a potentially incompatible template.
- RISK-002: Known Windows discovery-deadline stall and graceful-shutdown baseline failure must be reported separately.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Pending accepted UI edits are unrelated and will be preserved without staging.
- NOTE-002: The installed versioned Desktop backend reports 0.159.2; the top-level legacy executable reports 0.130.0-alpha.5 and must not be selected.
- NOTE-003: Full Bun suite: 420 pass, 18 skip, one existing Windows graceful-shutdown SIGTERM failure; discovery timeout completes with the installed Bun 1.4.2. No runtime fix was made for either baseline test.
- NOTE-004: All seven PowerShell suites passed; dynamic activation/restoration also passed Windows PowerShell 5.1, including interrupted worker installation and exact BOM/byte restoration. Actual 0.159.2 debug models loaded the generated catalog offline.
- NOTE-005: The existing fingerprint record format and SHA-256 are unchanged. Ordinal path ordering resolves .NET Framework versus .NET culture-sort differences; both PowerShell versions now produce the same reviewed pin.
- NOTE-006: Bun's tsc launcher shim failed to create a process. All server/frontend/helper typechecks and production compiler/build checks passed using the installed Node compiler directly; no dependency reinstall was performed.
- NOTE-007: During the original implementation, no deployment, OAuth, real inference, Desktop launch, active-home writes, commits or pushes were performed. Manual Desktop acceptance remained outstanding then.
- NOTE-008: The current adapter stores only runtime metadata and provenance. Guarded activation reads the unique matching value from `codex debug models --bundled`, checks its reviewed SHA-256 and UTF-8 length, and keeps it in memory until the temporary guarded catalog is generated.

## 9. Related Specifications / Further Reading

- tools/codex-devin/README.md
- src/admin/model-catalog.ts
