---
goal: Prepare private Dev Hub Docker Compose deployment for the Codex Desktop fork
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Maintainers
status: 'Completed'
tags: [infrastructure, docker, codex, security]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-completed-brightgreen)

Prepare a Git-based, locally built Docker Compose deployment for the `codex-desktop` fork. Keep upstream's Bun gateway image and entrypoint, bind the service only to a configured private host interface, and keep request credentials and raw diagnostics out of persistent server configuration.

## 1. Requirements & Constraints

- **REQ-001**: Build locally from the checked-out repository and existing Dockerfile; do not configure or publish registry images.
- **REQ-002**: Enable `DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM=1` in this Compose deployment while preserving the runtime's default-off behavior and exact two-model allowlist.
- **REQ-003**: Bind host port `38643` only to an explicitly configured private LAN or WireGuard interface address; do not assume or invent the host IP.
- **SEC-001**: Do not put Devin credentials in Compose, `.env`, the image, Git, or the persistent devhub filesystem. Use per-request authentication from Codex.
- **SEC-002**: Disable `DEBUG` and `ERROR_TRACE`; leave safe JSONL diagnostics opt-in and route it under the ignored logs mount.
- **CON-001**: Do not change Responses tool-loop or V1 multi-agent mappings, gateway source behavior, the known-good commit, or the temporary POC.
- **CON-002**: Docker is unavailable on the development machine; validate files and code locally without claiming an image/container run.
- **CON-003**: Do not deploy, publish an image, create a release, or add registry workflows.
- **PAT-001**: Preserve the existing Bun/Alpine entrypoint, production dependency installation, unprivileged runtime user, and healthcheck architecture.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Configure private, credential-free Compose runtime defaults and document operator workflows.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Configure `docker-compose.yml` to build the local Dockerfile, bind only the required private host IP on port 38643, enable collapse, disable debug/error tracing, leave safe diagnostics off, mount ignored logs, and verify collapse via healthcheck. | ✅ | 2026-10-01 |
| TASK-002 | Add a deployment-specific `devhub.env.example` containing only the required private bind address and exclude environment, logs, tests, tools, and plans from Docker build context. | ✅ | 2026-10-01 |
| TASK-003 | Replace registry-oriented Docker deployment instructions with Git-based first deployment, authentication guidance, health/model checks, update, and exact-commit rollback commands. | ✅ | 2026-10-01 |
| TASK-004 | Run offline Compose/YAML checks, focused gateway tests, TypeScript typecheck, production build, runtime-path audit, and `git diff --check`; report Docker as unrun because unavailable. | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: Store a server-side `DEVIN_API_KEY` in Compose or `.env`; rejected because it persists a bearer credential on devhub and exposes it through container configuration.
- **ALT-002**: Mount the upstream login token file into the container; rejected because the HTTP server uses per-request credentials and does not need persistent login state.
- **ALT-003**: Publish a GHCR or Docker Hub image; rejected because deployment is explicitly Git clone/pull plus local Compose build.
- **ALT-004**: Bind to `0.0.0.0` on the host; rejected in favor of an explicit private interface address and firewall restriction.

## 4. Dependencies

- **DEP-001**: Docker Engine and Docker Compose on devhub for the first real image build and health validation.
- **DEP-002**: A private LAN or WireGuard address on devhub, supplied by the operator in the ignored `.env` file.
- **DEP-003**: A Devin token kept on Windows in a protected secret store and injected into Codex Desktop for per-request authorization.
- **DEP-004**: `jq` on devhub for concise health assertions; PowerShell for the authenticated live model check from Windows.

## 5. Files

- **FILE-001**: `docker-compose.yml` — private host binding, runtime security defaults, healthcheck, and local build.
- **FILE-002**: `devhub.env.example` — non-secret private bind address setting.
- **FILE-003**: `.dockerignore` — exclude credentials, logs, test/capture files, operator tools, and documentation from build context.
- **FILE-004**: `README.md` — first deployment, authentication/network guidance, verification, update, and rollback.
- **FILE-005**: `plan/infrastructure-devhub-compose-1.md` — this execution record.

## 6. Testing

- **TEST-001**: Parse the Compose YAML locally and check its required interpolation and security-sensitive values.
- **TEST-002**: Run focused Responses, collapse, diagnostics, and server tests with Bun.
- **TEST-003**: Run `bun run typecheck` and `bun run build`.
- **TEST-004**: Verify production source has no machine-specific or temporary POC path dependency.
- **TEST-005**: Run `git diff --check` and inspect status/diff.
- **TEST-006**: Do not run Docker build/health because Docker is unavailable on the development machine; leave first image validation for devhub.

## 7. Risks & Assumptions

- **RISK-001**: An incorrect or unassigned `DEVIN_GATEWAY_BIND_IP` prevents Compose from publishing the port; Compose fails closed rather than binding broadly.
- **RISK-002**: The Dockerfile retains the upstream floating `oven/bun:1-alpine` tag, so a later build may use a newer Bun 1.x base image.
- **RISK-003**: Plain HTTP exposes the bearer token to the local network; use WireGuard for remote access or another encrypted private channel.
- **ASSUMPTION-001**: `/v1/models` performs live account discovery and requires the same per-request Devin credential used by Codex.
- **ASSUMPTION-002**: The existing Dockerfile's explicit `COPY src/` includes the system-collapse and optional safe-diagnostics runtime modules.

## 8. Audit Findings / Notes (Optional)

- **NOTE-001**: The existing image is a compact single-stage `oven/bun:1-alpine` build; it installs production dependencies, uses `su-exec` to run Bun as `gateway`, exposes container port 3000, and includes a `/health` check. No Dockerfile redesign was needed.
- **NOTE-002**: The gateway accepts per-request `Authorization`/`x-api-key`; the HTTP server does not read a persisted login token. The `bun run login` CLI persists and prints credentials, so it is not part of the recommended always-on deployment.
- **NOTE-003**: Source enables raw error-trace files unless `ERROR_TRACE=false`; the Compose file explicitly disables them. Debug request-body logging is also explicitly disabled.
- **NOTE-004**: Docker Engine/Compose was not available in the Windows development environment. Docker image build, health, live Devin model discovery, deployment, and network reachability remain unverified.

## 9. Related Specifications / Further Reading

- [Codex Desktop compatibility plan](feature-codex-desktop-compatibility-1.md)
- [Upstream Devin Gateway](https://github.com/CaiJingLong/devin-gateway)
- [Fork source](https://github.com/Jackthegr8at/devin-gateway/tree/codex-desktop)
