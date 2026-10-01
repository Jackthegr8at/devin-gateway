---
goal: Devin logical families and exact effort routing
version: '2.5'
date_created: '2026-10-01'
last_updated: '2026-10-01'
status: 'Completed'
tags: [models, compatibility, migration]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the approved Phase 2.5 without Windows activation changes or live requests.

## 1. Requirements & Constraints

- REQ-001: Authoritative protobuf family metadata takes precedence over reviewed fallback mappings.
- REQ-002: Preserve concrete selection granularity; migrate roles to explicit logical model and effort.
- SEC-001: Fail closed on ambiguous routing, invalid migration, and unvalidated roles.
- CON-001: Preserve exactly two compatibility profiles, collapse allowlist, OAuth and inference CORS.
- CON-002: No deployment, Windows activation changes, commits, or pushes.

## 2. Implementation Steps

### Implementation Phase 1

GOAL-001: Decode, project, persist, export and route families.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Decode fields 30/31 and nested metadata in src/devin.ts | ✅ | 2026-10-01 |
| TASK-002 | Add deterministic src/model-families.ts projection and strict routing | ✅ | 2026-10-01 |
| TASK-003 | Migrate model-selection and store to v2 with private original backup | ✅ | 2026-10-01 |
| TASK-004 | Update admin/catalog APIs and Responses routing | ✅ | 2026-10-01 |

### Implementation Phase 2

GOAL-002: Adapt picker and validate offline.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add family grouping and explicit role effort controls in web/model-picker | ✅ | 2026-10-01 |
| TASK-006 | Add decoder, routing, migration, export and UI regression tests | ✅ | 2026-10-01 |
| TASK-007 | Run Bun, typecheck, build, PowerShell and diff checks | ✅ | 2026-10-01 |

## 3. Alternatives

- ALT-001: Suffix inference rejected: model names do not establish capabilities.
- ALT-002: Default effort substitution rejected for logical-family requests.

## 4. Dependencies

- DEP-001: Existing protobuf decoder and reviewed exact-ID Codex profiles; no new packages.

## 5. Files

- FILE-001: src/devin.ts and src/model-families.ts.
- FILE-002: src/admin selection, storage, catalog and route modules; src/server.ts.
- FILE-003: web/model-picker DTO, state, API and components; focused tests.

## 6. Testing

- TEST-001: Synthetic metadata: SWE, Sol, Fast, 1M, Off, ambiguity and defaults.
- TEST-002: Byte-preserving migration, revision conflicts, strict role validation.
- TEST-003: Exact wire IDs, unchanged direct IDs, reviewed-only export, picker role controls.
- TEST-004: Full offline checks; no OAuth/inference/Desktop.

## 7. Risks & Assumptions

- RISK-001: Discovery can change family labels or remove variants; never substitute a route.
- RISK-002: Windows source fingerprint intentionally remains stale and is not refreshed.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Nested metadata schema verified read-only against installed OMP 18.4.9.
- NOTE-002: Upstream family default is distinct from the persisted Medium worker choice.
- NOTE-003: Full offline final run: 387 pass, 18 skip, one documented Windows baseline SIGTERM failure. One earlier run had two unexplained storage failures; full rerun and three isolated storage repeats passed.
- NOTE-004: PowerShell AST and five guard/recovery suites passed. Fingerprint suite stops at the intentionally unchanged stale pin; it was not refreshed or bypassed.
- NOTE-005: Local static-only browser QA at 1280x900 and 390x844: no overflow/errors; worker SWE-2/medium, invalid roles block Save. Screenshots stayed outside Git.
- NOTE-006: Production build, both TypeScript configurations, shell syntax and diff checks passed. No live Devin/OAuth/Desktop/deployment acceptance performed.
- NOTE-007: Legacy unknown concrete IDs remain pass-through; logical identities require discovery or reviewed exact-ID registration. Known removed families fail closed. No naming heuristic guesses logical identities.
- NOTE-008: Windows activation/catalog generation remain Phase 3 work. Historical Phase 1 acceptance helper is unchanged and must not be used against v2.
- NOTE-009: Subsequent authorized Linux acceptance used an isolated candidate checkout before committing. Full Linux suite: 389 pass, 17 skip, zero failures; typecheck, production build, shell syntax and diff checks passed. Docker package downloads required host build networking; no runtime networking changed.
- NOTE-010: Real v1 revision 6 migrated to v2 revision 6 without changing seven existing enabled IDs or the future flag. GLM Low remained concrete; worker became SWE-2/medium. Private v1 backup matched original SHA-256 byte-for-byte; directory/file/backup stayed gateway-owned 0700/0600/0600.
- NOTE-011: Linux storage acceptance completed 24 saves, 288 concurrent reads, 24 stale-ETag rejections and 24 invalid-write rejections across three immediate gateway recreations. Each recreation preserved bytes exactly, with no temporary files or permission drift. Original selection/roles were restored; revision advanced monotonically to 30.
- NOTE-012: Live discovery: SWE-2 medium/high/max exact routes, GPT-6.1 Sol standard/Fast lanes with no Off, separate discovered 1M lanes, 61 families and six standalone rows. Codex export remained GLM Low/SWE-2 Medium only. Routing/picker/migration regressions: 46 pass. No production inference, OAuth or Desktop launch.
- NOTE-013: Five Windows guard/recovery suites and PowerShell AST passed again. Fingerprint mismatch remains intentional. Earlier Windows storage failures (3028.60ms and 3033.77ms) have incomplete retained diagnostics; no root cause is proven and tests were not weakened. Passing Linux stress does not establish the Windows cause.

## 9. Related Specifications / Further Reading

See Phase 1/2 model-selection plans and the accepted Phase 2.5 request.
