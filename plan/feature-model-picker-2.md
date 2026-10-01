---
goal: Cody-style management model picker, Phase 2 only
version: 1
date_created: 2026-10-01
last_updated: 2026-10-01
status: Completed
tags: [feature, frontend, security]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Implement the approved standalone picker from Phase 1 commit 72fdc9172ea688cdca22508c4ba2e724f43a87d5. Keep changes uncommitted and do not deploy.

## 1. Requirements & Constraints

- REQ-001: Reuse Cody's display category union, pagination and draft/bulk interactions; only SWE, Fusion and Other.
- REQ-002: One draft with exact IDs, roles, future flag and revision; save only by explicit JSON PUT with ETag.
- SEC-001: Static assets and UI only on the existing guarded management listener; retain Host/Origin/CSRF checks and no inference CORS.
- CON-001: No PowerShell activation changes, new compatibility profiles, inference/OAuth/volume/network changes or live requests.
- CON-002: Phase 1 requires two role references. Disable-assigned drafts block Save until re-enabled or reassigned; do not invent role removal in the backend contract.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Build the small React picker using native accessible controls and Cody's already-approved compact visual direction.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Adapt web/model-picker/model-categories.ts, model-pagination.ts and model-display.ts with MIT attribution. | Yes | 2026-10-01 |
| TASK-002 | Implement web/model-picker/state.ts and api.ts for one draft, future policy, eligibility and bounded ETag API calls. | Yes | 2026-10-01 |
| TASK-003 | Implement ModelPicker.tsx, ModelRow.tsx, RoleAssignments.tsx, main.tsx, index.html and styles.css. | Yes | 2026-10-01 |

### Implementation Phase 2

- GOAL-002: Package and serve fixed static assets without changing API contracts or listener isolation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add scripts/build-model-picker.ts and web typecheck; integrate production/Docker builds and MIT notices. | Yes | 2026-10-01 |
| TASK-005 | Add src/admin/static.ts with fixed asset allowlist and CSP; route it only after management request validation. | Yes | 2026-10-01 |
| TASK-006 | Add focused domain, React DOM/API and static-listener regression tests, then run offline checks and document acceptance commands. | Yes | 2026-10-01 |

## 3. Alternatives

- ALT-001: Reject Next.js, Cody's OMP/config writer, account UI and extra component/icon frameworks; native controls with React are sufficient.
- ALT-002: Reject capability inference from category/name. Role eligibility comes only from reviewed backend metadata.

## 4. Dependencies

- DEP-001: React and React DOM runtime; DOM test environment and React types are development-only. Existing Bun bundles the frontend.
- DEP-002: Phase 1 APIs and management listener remain the only data/security contract.

## 5. Files

- FILE-001: web/model-picker/**, scripts/build-model-picker.ts, tsconfig.web.json, package.json and bun.lock.
- FILE-002: src/admin/static.ts, src/server.ts, Dockerfile, .dockerignore, README.md and tests.

## 6. Testing

- TEST-001: 500+ models, search/name/ID, category union, draft enabled filter, 60-row pagination and filtered bulk actions.
- TEST-002: Save/Cancel/Escape, role validity, missing models, future mode and 412 conflict recovery without overwrite.
- TEST-003: Static route isolation, security headers, Host/Origin checks, bounded API calls and packaged assets.
- TEST-004: Full offline Bun and PowerShell suites, TypeScript checks, production build, shell syntax, privacy and diff checks. No live Devin or deployment.

## 7. Risks & Assumptions

- RISK-001: Runtime/package changes invalidate the existing Windows reviewed fingerprint. Do not edit activation tooling; report that review gate if still stale.
- RISK-002: Model catalog and selection GETs can race a concurrent update; reject revision mismatch rather than combining inconsistent state.
- ASSUMPTION-001: Visual target is Cody's neutral charcoal surfaces, compact rows/badges and accessible fixed footer, not a new design direction.

## 8. Audit Findings / Notes (Optional)

- NOTE-001: Cody reference codex/maintained at 89b58b0cabf1e5aa9797b542748068c6aa795eea; MIT copyright 2026 agegr. No Cody files are modified.
- NOTE-002: Offline Bun: 374 passing, 18 skipped, one documented baseline Windows SIGTERM failure. All 28 new picker tests pass. TypeScript/server and browser checks, production build and diff checks pass. Five PowerShell suites pass; the unchanged reviewed-fingerprint suite fails closed as expected after runtime/package changes. No activation pin was updated.
- NOTE-003: Built UI rendered in local headless Edge against 522 synthetic models at 1280x900 and 390x844: 60 rows/page, no horizontal overflow, no console/page errors, reduced-motion and native keyboard focus verified. Screenshot inspection confirms compact dark layout and stacked mobile roles. The critic skill's optional scoring config is absent, so no numerical design-quality score is claimed.
- NOTE-004: Docker build, real SSH/browser acceptance, and live discovery were not run. Manual devhub acceptance remains required after review/publication; Phase 3 Windows catalog activation remains explicitly out of scope.

## 9. Related Specifications / Further Reading

- plan/feature-model-selection-1.md and README.md for the validated API/security contract.
- web/model-picker/THIRD_PARTY_NOTICES.txt records Cody attribution and license.
