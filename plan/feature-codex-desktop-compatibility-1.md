---
goal: Port the proven Codex Desktop Responses and native-agent compatibility into a clean Devin Gateway fork candidate
version: 1.0
date_created: 2026-09-30
last_updated: 2026-09-30
owner: Maintainers
status: 'Ready to push; Docker validation pending'
tags: [feature, architecture, migration, codex, responses]
---

# Introduction

![Status: Ready to push; Docker pending](https://img.shields.io/badge/status-ready%20to%20push%3B%20Docker%20pending-blue)

This plan ports the proven Codex Desktop compatibility into a clean checkout based on upstream `ca826020604075549bee1c0768ca269cd6842ebe` (`v0.7.0`). The temporary POC remained read-only. The implementation phase used local mocks only; the user subsequently performed the one authorized live Desktop validation. Publishing, deployment, and remote pushes remain out of scope.

## 1. Requirements & Constraints

- **REQ-001**: Preserve the upstream Responses implementation and add Codex tool-loop behavior incrementally.
- **REQ-002**: Support Responses `function_call` and `function_call_output`, reasoning summaries, usage, streaming completion/error, and exact Devin call-ID continuity.
- **REQ-003**: Reconstruct tool arguments from cumulative snapshots and fragments; reject more than one call per model response with a safe explicit error.
- **REQ-004**: Forward only `exec_command` and the five `multi_agent_v1` methods; do not add `get_hostname` as production functionality.
- **REQ-005**: Preserve JSON schemas and restore the `multi_agent_v1` namespace in Responses output/history.
- **REQ-006**: Replace only the top-level `exec_command` description with `Run a local command.`
- **REQ-007**: Add opt-in system collapse behind `DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM=1`, allowlisted only for `glm-5-3-flash-low` and `swe-2-medium`.
- **SEC-001**: The gateway never executes forwarded tools and must not persist or migrate POC credentials.
- **SEC-002**: Safe Responses diagnostics, if retained, require an explicit opt-in and may persist only allowlisted hashes/lengths/IDs/status; never raw prompts, arguments, schemas, or credentials.
- **CON-001**: Keep the temporary POC reference unchanged and read-only; its machine-local path is intentionally not recorded in this repository.
- **CON-002**: Do not port temporary POC capture utilities, captured payloads, catalog experiments, the OAuth bridge into the gateway runtime, raw tool audit, or experimental `/v1/models` metadata. The separate Windows operator helper uses lower-level OAuth primitives and keeps the credential in memory only.
- **CON-003**: Do not push or publish images during implementation. The user-run Desktop validation was separately authorized after local implementation.
- **CON-004**: Preserve upstream Dockerfile, Compose, Alpine/Bun runtime, unprivileged user, entrypoint, and healthcheck.
- **PAT-001**: Use focused synthetic fixtures and tests; do not copy real Desktop captures wholesale.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish a clean local fork candidate at the reviewed upstream base and record the migration plan.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Check out upstream commit `ca826020604075549bee1c0768ca269cd6842ebe` on local branch `codex-desktop`; configure `upstream` and configure `origin` only if a personal fork URL is verifiably available. | ✅ | 2026-09-30 |
| TASK-002 | Record the clean baseline and upstream package/test/build/container commands before source changes. | ✅ | 2026-09-30 |

### Implementation Phase 2

- GOAL-002: Implement Responses tool input decoding and Devin tool declarations without replacing upstream endpoint behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Decode Responses messages, reasoning summary items, function-call items, and function-call outputs into upstream internal messages while preserving call IDs. | ✅ | 2026-09-30 |
| TASK-004 | Map only `exec_command` and the five `multi_agent_v1` tool names; preserve schemas, rewrite only the `exec_command` description, and retain the original namespace/name identity for response reconstruction. | ✅ | 2026-09-30 |
| TASK-005 | Add safe validation for unsupported/malformed tools and the single-tool-call-per-response constraint. | ✅ | 2026-09-30 |

### Implementation Phase 3

- GOAL-003: Complete streamed Responses output and tool round trips.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Aggregate Devin tool-call deltas/snapshots, retaining Devin IDs and producing complete function-call arguments. | ✅ | 2026-09-30 |
| TASK-007 | Emit Responses reasoning, text, function-call, usage, success, and error events while retaining existing upstream behavior for ordinary text requests. | ✅ | 2026-09-30 |
| TASK-008 | Add local mock continuation tests that return `function_call_output` with the same ID; verify the gateway never executes a tool. | ✅ | 2026-09-30 |

### Implementation Phase 4

- GOAL-004: Bridge Codex native `multi_agent_v1` tool calls.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | Verify all five exact Devin-facing names and reverse-map calls to the Responses namespace/name in streaming and history. | ✅ | 2026-09-30 |
| TASK-010 | Cover each V1 mapping, ID preservation, result continuation, and one-call restriction with synthetic tests. | ✅ | 2026-09-30 |

### Implementation Phase 5

- GOAL-005: Add guarded Desktop system-collapse compatibility.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Port collapse as an isolated opt-in transformation for only GLM-5.3 Flash Low and SWE-2 Medium, preserving content/history/tools and leaving strict Devin system/prompt empty. | ✅ | 2026-09-30 |
| TASK-012 | Test default-off, both allowlisted models, unrelated model, and exact content preservation. | ✅ | 2026-09-30 |

### Implementation Phase 6

- GOAL-006: Retain diagnostics only if isolated and safe by default.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | Audit the diagnostic implementation; if retained, gate it behind a dedicated explicit opt-in and enforce an allowlisted JSONL schema with secret/prompt/argument redaction tests. | ✅ | 2026-09-30 |
| TASK-014 | Exclude raw tool-call audit and unsafe request/header/error logging from the production path. | ✅ | 2026-09-30 |

### Implementation Phase 7

- GOAL-007: Document authentication and Codex Desktop configuration while preserving upstream auth semantics.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Document static Codex catalog/provider configuration, collapse opt-in, and the difference between POC memory-only OAuth and upstream per-request/API-key authentication. | ✅ | 2026-09-30 |
| TASK-016 | Leave `/v1/models` experimental metadata and Devin credential persistence out of scope. | ✅ | 2026-09-30 |

### Implementation Phase 8

- GOAL-008: Verify regression, type safety, production build, and Docker compatibility locally.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | Run focused synthetic tests, full test suite, direct TypeScript typecheck, production build, and `git diff --check`; report the reproduced upstream Windows shutdown failure separately. | ✅ | 2026-09-30 |
| TASK-018 | Build the unchanged upstream Docker image and verify container `/health` on port 38643 when a local Docker engine is available. | — | 2026-09-30 |
| TASK-019 | Record image size, any environment limitations, and differences from the proven POC. | — | 2026-09-30 |

### Implementation Phase 9

- GOAL-009: Create reviewable local commits only after validation succeeds.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Commit the Responses/native-agent implementation, guarded collapse, focused tests, maintained Windows operator tooling, and compatibility documentation in reviewable local commits; do not push. | ✅ | 2026-09-30 |

## 3. Alternatives

- **ALT-001**: Replace the upstream Responses endpoint wholesale; rejected because it would discard unrelated upstream behavior and increase regression risk.
- **ALT-002**: Port all POC scripts, captured requests, catalogs, OAuth bridge, and diagnostics; rejected because these are test scaffolding, contain unnecessary sensitive surfaces, or were explicitly excluded.
- **ALT-003**: Add dynamic native Codex model-catalog metadata; deferred because the proven workflow uses a static catalog and the POC's empty reasoning-level metadata caused a worker failure.

## 4. Dependencies

- **DEP-001**: Bun and the existing lockfile/package dependencies for local tests, typecheck, and build.
- **DEP-002**: Docker engine for image and container-health validation; report unavailable if not installed/running.
- **DEP-003**: Synthetic local HTTP mocks only; no Devin credentials or remote inference are needed.

## 5. Files

- **FILE-001**: `src/convert.ts` — Responses item/tool parsing, mapping, and history identity.
- **FILE-002**: `src/server.ts` — incremental Responses endpoint request and streaming integration.
- **FILE-003**: `src/devin.ts` — safe error/trace handling for the Responses diagnostic context.
- **FILE-004**: `src/responses-system-collapse.ts` and `src/responses-diagnostics.ts` — isolated opt-in compatibility transformation and safe JSONL diagnostic.
- **FILE-005**: `test/*` — synthetic conversion, continuation, stream, collapse, redaction, and regression tests.
- **FILE-006**: `README.md` — Codex Desktop setup, limitations, and auth distinction.
- **FILE-007**: `plan/feature-codex-desktop-compatibility-1.md` — this execution record.
- **FILE-008**: `tools/codex-devin/**` — maintained, guarded Windows operator/test workflow; local-only OAuth remains separate from the gateway runtime.

## 6. Testing

- **TEST-001**: Verify function-call ID and namespace round-trip and function-call output continuation.
- **TEST-002**: Verify fragmented and cumulative snapshot reconstruction plus a safe multiple-call error.
- **TEST-003**: Verify reasoning, text, usage, success, and error Responses events.
- **TEST-004**: Verify exact `exec_command` description rewrite with schema unchanged.
- **TEST-005**: Verify all five V1 mappings and namespace restoration.
- **TEST-006**: Verify collapse off by default, enabled only for both allowlisted models, preserving exact content and history.
- **TEST-007**: Verify diagnostics, if retained, are opt-in and never persist synthetic secrets, prompt text, schema, or arguments.
- **TEST-008**: Run upstream full tests, `tsc --noEmit`, production build, Docker build, and local `/health` when Docker is available.

## 7. Risks & Assumptions

- **RISK-001**: Devin tool-call event formats include both delta fragments and replacement snapshots; aggregation must be tested against existing protocol semantics before commit.
- **RISK-002**: Codex Desktop requests include extensive system/developer content; collapse must remain exact, narrowly allowlisted, and opt-in.
- **RISK-003**: Docker validation cannot be completed when a Docker engine is unavailable.
- **ASSUMPTION-001**: The upstream base remains `ca826020604075549bee1c0768ca269cd6842ebe`; verify before final commits.
- **ASSUMPTION-002**: The successful POC behavior is the compatibility oracle, but POC source remains read-only.

## 8. Audit Findings / Notes (Optional)

- **NOTE-001**: The destination was absent; current upstream `main` resolved to the approved base; the POC remained dirty and unchanged.
- **NOTE-002**: No GitHub CLI was available to establish a personal fork URL, so the local checkout has an `upstream` remote and no invented `origin`.
- **NOTE-003**: Docker CLI is unavailable in the current environment; Docker validation is pending an available engine.
- **NOTE-004**: The focused synthetic suite passed (123 tests); direct typecheck and production build passed. Full suite ran 314 tests: 296 passed, 17 skipped, and the unchanged Windows graceful-shutdown test failed because the child process reported `signalCode: SIGTERM` instead of a normal exit. The same test was already failing on the unmodified upstream baseline.
- **NOTE-005**: The implementation agent did not send a Devin request or launch Desktop. The user later completed the real Desktop GLM parent → native `swe_worker` → SWE-2 Medium flow; safe diagnostics reported SWE-2 Medium completed with system collapse enabled and the worker result returned to the parent. Docker image build, container health, and image size were not verified because Docker is unavailable.
- **NOTE-006**: Local commits created after staged-diff review: `74cd36e` (`feat(codex): support Responses tools and Desktop compatibility`), `7b127ad` (`feat(codex): add guarded Desktop test tooling`), and `197c668` (`test(codex): cover Desktop compatibility and safety`). No push, repository creation, deployment, or image publication was attempted. The branch is ready for the user to push after review; Docker validation remains outstanding.
- **NOTE-007**: Excluded obsolete local capture utilities `Capture-LocalDesktopResponses.mjs` and `Start-DesktopLocalCapture.ps1`, plus unused `CodexDevin.ProcessIdentity.cs`; the old original reference copy was not touched. The enable script validates the durable Codex catalog directly and has no dependency on the temporary test-home catalog. Ignored safe diagnostic logs and recovery backups were not staged.

## 9. Related Specifications / Further Reading

- [Upstream Devin Gateway](https://github.com/CaiJingLong/devin-gateway)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- Known-good POC: read-only local reference; its machine-specific path is intentionally omitted.
