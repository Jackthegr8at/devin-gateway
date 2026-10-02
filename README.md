# Devin Gateway

English | [简体中文](README.zh-CN.md)

Expose the Devin/Windsurf Cascade API through OpenAI- and Anthropic-compatible endpoints for Cherry Studio and other compatible clients.

> [!IMPORTANT]
> An active Devin or Windsurf subscription is required. This gateway does not provide an account, subscription, or usage quota.

## Features

- OpenAI Chat Completions: `POST /v1/chat/completions`, with streaming support
- OpenAI Responses: `POST /v1/responses`, with streaming support
- Anthropic Messages: `POST /v1/messages`, with streaming support
- Model listing: `GET /v1/models`
- OAuth login CLI (`bun run login`) to obtain a Devin token
- Per-request credentials: clients pass their own token via `Authorization` or `x-api-key`
- No third-party runtime dependencies; Protobuf encoding and decoding are implemented in the project

## Quick start

### 1. Sign in to Devin

```bash
bun install
bun run login
```

A browser window opens automatically. After sign-in, the token is printed and stored at `~/.devin-gateway/token`. Copy it into your client's API key field.

Other CLI options:

```bash
bun run login:paste       # Paste the callback URL manually
bun run login:status      # Show the current saved token status
bun run login -- --print  # Print the token without saving it
```

### 2. Start the gateway

```bash
bun run start
```

The gateway listens on `http://localhost:3000` by default. Requests may carry credentials via `Authorization: Bearer <token>` (OpenAI clients) or `x-api-key: <token>` (Anthropic clients). A fallback can also be loaded at startup from `DEVIN_API_KEY` or the saved login token; per-request credentials continue to take precedence.

### Codex Desktop (Responses API)

The gateway's `/v1/responses` endpoint supports the Codex tool loop for `exec_command` and the five `multi_agent_v1` functions. The gateway only translates these function calls; it never executes them. Codex remains responsible for running local commands and returning `function_call_output` items with the matching call ID.

Run the gateway on a loopback-only port for a same-computer Desktop setup:

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "38643"
bun run start
```

Codex's custom-provider, Responses transport, and static model-catalog settings are configured in the user's Codex config. The following is a compatibility example; replace the catalog path with a catalog created for the exact Codex runtime in use:

```toml
model = "glm-5-3-flash-low"
model_provider = "devin_gateway"
model_reasoning_effort = "low"
model_catalog_json = "C:/path/to/devin-model-catalog.json"
multi_agent_version = "v1"

[model_providers.devin_gateway]
name = "Devin Gateway"
base_url = "http://127.0.0.1:38643/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

For the devhub Docker workflow below, Codex Desktop does not manage a Devin credential and the provider has no `env_key`: the gateway uses its server-side fallback loaded from the Docker auth volume. The ordinary CLI login remains available for standalone setups. No POC credential helper is used by the gateway runtime.

`model_catalog_json` is local Codex picker metadata, not a Devin entitlement check or a live model catalog. The tested Desktop setup used a static catalog containing the exact Devin model IDs and reasoning metadata. A custom catalog may replace Codex's built-in catalog for that configuration, so include every model needed in that Codex environment. See the [Codex config reference](https://developers.openai.com/codex/config-reference/) for provider and catalog settings.

For the tested native worker setup, declare the role only in the Codex configuration where `devin_gateway` is active:

```toml
[agents.swe_worker]
description = "Complete a scoped repository task and report back concisely."
config_file = "agents/swe_worker.toml"
```

`agents/swe_worker.toml`:

```toml
model = "swe-2-medium"
model_reasoning_effort = "medium"
developer_instructions = "Explore the assigned repository and complete only the scoped subtask. For implementation work, make focused changes and run relevant tests. Do not change permissions, sandbox settings, or unrelated files. Report changes, checks, and blockers concisely to the parent."
```

The worker intentionally omits `model_provider`, so it inherits the parent's provider. Do not leave this role active under an unrelated provider configuration. Codex's [`agents.<name>.config_file`](https://developers.openai.com/codex/config-reference/) is relative to the config file that declares the role.

The optional `DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM=1` gateway setting enables the tested system-prompt compatibility transformation only for `glm-5-3-flash-low` and `swe-2-medium`. It moves the exact composed system/developer text into the latest user turn without truncating or rewriting it; it does not change history or tool declarations. Leave it unset unless using that compatibility path.

### Model selection foundation

`DEVIN_MODEL_SELECTION_ENABLED=1` enables version-2 selection storage and the read-only `GET /gateway/api/codex-selection` manifest. It is disabled by default for standalone/library users; the private Docker Compose gateway enables it. The management picker configures the gateway only; existing Windows activation scripts still use their validated static catalog. `/v1/models`, inference credentials, CORS, tool translation, and the collapse allowlist are unchanged.

Settings live in `$DEVIN_GATEWAY_SETTINGS_DIR/model-selection.json` (default `~/.devin-gateway-settings/model-selection.json`). Compose mounts the separate `devin-gateway-settings` named volume at `/home/gateway/.devin-gateway-settings`; `devin-login` continues to mount only `devin-gateway-auth`. Never combine those directories or delete either named volume during recreation.

First initialization seeds only:

```json
{
  "schemaVersion": 2,
  "revision": 1,
  "enabledModels": ["glm-5-3-flash-low", "swe-2-medium"],
  "roles": {
    "default": {"modelId": "glm-5-3-flash-low", "effort": "low"},
    "swe_worker": {"modelId": "swe-2", "effort": "medium"}
  },
  "includeFutureModels": false
}
```

The exact-ID reviewed profiles advertise only GLM `low` and SWE-2 `medium`, with descriptions on their singleton supported-effort rows. Unknown IDs can be enabled but cannot be assigned to a role or acquire an inferred profile. Removed upstream models remain in the selection and are shown as unavailable. A missing role model or incomplete upstream limits/image metadata blocks manifest generation rather than substituting another model. Discovery itself does not prove an account can invoke a listed model.

The store uses private POSIX directory/file modes (`0700`/`0600`), a flushed temporary file and atomic rename, plus a bounded filesystem writer lock. A corrupt existing file stops initialization or returns a sanitized `503`; it is never overwritten with defaults. After an interrupted writer, an abandoned `.selection-write.lock` fails closed: confirm every writer is stopped before manually removing that lock. Normal saves leave no lock or temporary file.

Management endpoints are served only when `DEVIN_ADMIN_PORT` is explicitly set alongside enabled selection. This separate listener defaults to `127.0.0.1`. Compose explicitly uses `DEVIN_ADMIN_HOST=0.0.0.0` and port `3001` inside the container, published **only** as `127.0.0.1:38644:3001` on the host. `DEVIN_ADMIN_PUBLIC_PORT=38644` permits that exact loopback authority through the Host/Origin guard; LAN hosts and forwarded-host headers are not trusted. The listener rejects cross-site fetch metadata and has no inference CORS/raw tracing. The Phase 2 picker at `/admin/` uses this listener only:

| Method/path | Response |
|---|---|
| `GET /admin/api/models` | `{source:"remote", selectionRevision, models:[...], families:[...]}` with concrete IDs, family/effort grouping, availability, provenance and reviewed compatibility |
| `GET /admin/api/model-selection` | Version-2 selection plus an `ETag` header |
| `PUT /admin/api/model-selection` | Validated saved selection and new ETag |
| `GET /gateway/api/codex-selection` (inference listener) | Allowlisted selection revision/profile version, eligible models, explicit role efforts and excluded-model reasons |

PUT requires `Content-Type: application/json`, `X-Devin-Management: 1`, and the exact current `If-Match` ETag. Submit the current revision in the JSON; the store increments it on success. Missing precondition is `428`, stale revision is `412`, invalid selection is `400`. Reads are `no-store`; bodies are bounded to 256 KiB and five seconds. The explicit management header and same-origin checks provide the non-cookie CSRF foundation; Phase 2 must preserve these protections.

`includeFutureModels=true` can be saved only when every currently discovered model is selected. Newly discovered models then become effectively enabled, without changing roles or gaining Codex compatibility. An ordinary partial selection must use `false`. Discovery failures do not fall back to the bundled catalog.

The Codex manifest contains no scripts, instructions, TOML, permissions or OAuth credentials. It is **not** a complete Codex `ModelInfo` catalog: later Windows integration must combine these facts with a trusted template for the exact installed Codex runtime. Only the two currently reviewed IDs are eligible. Unvalidated selections are reported under `excludedModels`, not silently included.

Access management through an SSH local forward from Windows (`ssh -L 38644:127.0.0.1:38644 <private-host>`), then use `http://127.0.0.1:38644/admin/api/...`. Do not publish port 38644 on a LAN, WireGuard, or public interface. Inference remains on its existing private port 38643. The Windows reviewed-source pin is refreshed only after reviewing the final Phase 1 runtime diff; the fingerprint algorithm and guards remain unchanged.

Offline coverage:

```bash
bun test test/model-selection.test.ts test/model-selection-api.test.ts test/model-selection-docker.test.ts
bun run typecheck
bun run build
```

Linux permission tests run only on POSIX. Phase 1 acceptance additionally checks actual named-volume persistence across gateway recreation without removing the existing auth/settings volumes; a filesystem/gateway restart test alone is not Docker runtime proof.

`tools/Validate-ModelSelectionPhase1.ts` is retained as historical version-1 acceptance tooling. Do not run it against schema v2: its assertions intentionally target the old concrete-ID contract. Phase 2.5 offline coverage is:

```bash
bun test test/model-families.test.ts test/model-family-routing.test.ts test/model-selection-api.test.ts
```

These tests use synthetic loopback upstreams and disposable selection directories, never real credentials or inference.

Safe Responses diagnostics are disabled by default. To opt in, set `DEVIN_RESPONSES_SAFE_DIAGNOSTICS=1`; one allowlisted JSON record per Responses request is appended to the ignored `logs/responses-safe-diagnostic.jsonl`. Records contain hashes/byte lengths and limited model, tool, status, error-category, and call-ID metadata—not raw prompt text, tool arguments, schemas, descriptions, credentials, or headers. Hashes can still reveal matches for guessable text, so treat the log as diagnostic data and do not publish it. An alternate output path can be set with `DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH`.

### Self-hosted Docker Compose (Codex Desktop)

This fork is deployed by building the checked-out Git branch on the Linux host. The Compose service builds from this repository's `Dockerfile`; it does not require a published image or a registry login.

The gateway listens on port `3000` inside the container and publishes host port `38643` only on the private address set in `.env`. Prefer the host's WireGuard interface address when Codex connects over WireGuard. Otherwise use a private LAN interface and restrict TCP `38643` in the host firewall to trusted client addresses. Do not create a router port-forward or expose this service to the public Internet.

The gateway and `devin-login` containers also require outbound HTTPS to Devin. A restrictive `DOCKER-USER` policy can block this traffic while `/health` still returns `ok`. If paste login stalls after submitting the callback URL, check HTTPS connectivity from the Docker network, not only from the host. The login CLI reports when it receives the callback and bounds the token exchange to 30 seconds; it does not retry the exchange automatically.

#### First deployment on the host

```bash
git clone https://github.com/Jackthegr8at/devin-gateway.git
cd devin-gateway
git checkout codex-desktop
cp devhub.env.example .env
```

Edit `.env` and set `DEVIN_GATEWAY_BIND_IP` to the private LAN or WireGuard address assigned to this host. `.env` is Git-ignored and Docker-ignored; it must contain only this non-secret bind address.

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f devin-gateway
```

The container runs the existing Alpine/Bun image entrypoint, which starts Bun as the unprivileged `gateway` user. The Dockerfile healthcheck verifies `/health` returns success; the Compose healthcheck additionally requires `status: ok` and `collapse_system_enabled: true`.

#### Authentication and secret handling

Devin authentication is owned by the gateway on devhub. Both Compose services mount the named volume `devin-gateway-auth` at `/home/gateway/.devin-gateway`; the existing login CLI writes its token there, and the gateway reads it once at startup into the existing in-memory fallback-token path. The token is not included in the image, repository, `.env`, Compose values, or logs. The Docker login service uses `--no-display-token` so successful login output never prints the credential.

After the first deployment, run this from a Windows PowerShell window. The URL is printed by the existing Devin PKCE login flow. Open it in your browser; if the redirect cannot reach the container, paste the full redirect URL into the SSH terminal prompt. The code exchange and token write happen inside the container, and the token remains on devhub:

```powershell
ssh -t <ssh-user>@<gateway-host> "cd '<gateway-directory>' && sudo -n docker compose run --rm devin-login"
ssh <ssh-user>@<gateway-host> "cd '<gateway-directory>' && sudo -n docker compose up -d --force-recreate devin-gateway"
```

The guarded Windows worker wrapper can run the same interactive login step automatically over SSH only when remote `/health` reports `fallback_token: not_set`. It does not read or transfer the credential. When the health state is `set`, it skips OAuth and gateway restart. Request-supplied `Authorization` and `x-api-key` values, if any, retain their existing precedence over the fallback.

The container writes normal operational logs to stderr, so `docker compose logs -f devin-gateway` works without debug mode. `DEBUG` and `ERROR_TRACE` are explicitly disabled; error traces can otherwise include request bodies. Safe Responses diagnostics are disabled by default. Their configured path is `/app/logs/responses-safe-diagnostic.jsonl`, under the ignored `./logs` bind mount, so they can be explicitly enabled later without changing the image. Do not enable raw debug/error tracing for routine operation.

#### Health and live model verification

On devhub, replace the placeholder with the actual private host address:

```bash
curl -fsS 'http://<private-devhub-ip>:38643/health' | jq -e '.status == "ok" and .collapse_system_enabled == true'
```

For the live Devin catalog, replace the host placeholder. The remote gateway uses its startup fallback token; no credential is needed in the Windows process:

```powershell
$base = 'http://<private-devhub-ip>:38643'
$ids = (Invoke-RestMethod -Uri "$base/v1/models" -TimeoutSec 3).data.id
foreach ($required in @('glm-5-3-flash-low', 'swe-2-medium')) {
    if ($required -notin $ids) { throw "Required Devin model is missing: $required" }
    "AVAILABLE $required"
}
```

`/health` is unauthenticated and reports the collapse flag plus `fallback_token: set` or `not_set` (never the token itself). `/v1/models` performs live Devin discovery using the startup fallback token. For first deployment, run `sudo -n docker compose run --rm devin-login` on devhub and then recreate the gateway as shown above.

#### Updating the deployment

```bash
cd devin-gateway
git fetch origin
git checkout codex-desktop
git pull --ff-only origin codex-desktop
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
```

Review the fetched commit before rebuilding when you want a deliberate update. `--ff-only` prevents an accidental merge commit; `--pull` refreshes the Docker base image.

#### Rollback

Before each update, record the currently deployed commit. Roll back to that previous deployment commit (which includes the matching Compose configuration) without rewriting a branch:

```bash
cd devin-gateway
git rev-parse HEAD
# Save the printed SHA as PREVIOUS_DEPLOYED_COMMIT before updating.
# If the update fails, check out that saved SHA:
git checkout --detach <previous-deployed-commit>
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
```

Return to the branch afterward with `git checkout codex-desktop`. A detached checkout is local and does not move or rewrite any remote branch. The current Desktop-validated application commit is `c89f73c63ce3399ae9bc6b62125fea9ddb891f31`; it predates this local Compose preparation, so use it as a code-validation reference, not as a deployment rollback point unless the corresponding private-bind Compose configuration is retained.

## Getting a Devin token

### CLI login (recommended)

```bash
bun run login
```

A successful login writes the token to `~/.devin-gateway/token` and prints it. Copy the printed token into your client's API key field.

### Environment variable (optional server fallback)

Set `DEVIN_API_KEY` to provide a fallback token for requests that omit `Authorization`/`x-api-key` headers. This is optional — the common case is for each client to send its own token.

## Cherry Studio configuration

### OpenAI mode

| Setting | Value |
| --- | --- |
| API base URL | `http://localhost:3000/v1` |
| API key | Your Devin token |
| Model | Read from `GET /v1/models`, for example `claude-opus-4-8-low` or `gpt-5-5-none` |

### Anthropic mode

| Setting | Value |
| --- | --- |
| API base URL | `http://localhost:3000` |
| API key | Your Devin token |
| Model | Same list as OpenAI mode |

## Models

The built-in catalog covers Claude, Fable, GPT, Gemini, GLM, Grok, Kimi, DeepSeek, SWE, Inkling, Nemotron, and related model families. Regenerate it with `devin models list --format json` (see `src/models.ts` for the field mapping).

```bash
# Current models reported by the Devin API; requires a valid token
curl http://localhost:3000/v1/models

# Built-in snapshot bundled with this gateway
curl 'http://localhost:3000/v1/models?source=local'
```

> **Note**: `/v1/models` loads the live Devin catalog by default; `?source=remote` is an explicit equivalent. The table below is a snapshot of the built-in catalog at the time shown. Devin's available models change at any time, so this list is **for reference only and is not a constraint on the workflow** — `model` accepts any raw Cascade UID and passes unknown UIDs straight through. Use `GET /v1/models` for the live list.

<details>
<summary>Model catalog snapshot (2026-09-17)</summary>

**Snapshot time: 2026-09-17**

| Model id | Name | Context window | Max tokens |
| --- | --- | --- | --- |
| `claude-opus-5-medium` | Claude Opus 5 Medium | 1,000,000 | 128,000 |
| `claude-opus-5-low` | Claude Opus 5 Low | 1,000,000 | 128,000 |
| `claude-opus-5-high` | Claude Opus 5 High | 1,000,000 | 128,000 |
| `claude-opus-5-xhigh` | Claude Opus 5 XHigh | 1,000,000 | 128,000 |
| `claude-opus-5-max` | Claude Opus 5 Max | 1,000,000 | 128,000 |
| `claude-opus-5-low-fast` | Claude Opus 5 Low Fast | 1,000,000 | 128,000 |
| `claude-opus-5-medium-fast` | Claude Opus 5 Medium Fast | 1,000,000 | 128,000 |
| `claude-opus-5-high-fast` | Claude Opus 5 High Fast | 1,000,000 | 128,000 |
| `claude-opus-5-xhigh-fast` | Claude Opus 5 XHigh Fast | 1,000,000 | 128,000 |
| `claude-opus-5-max-fast` | Claude Opus 5 Max Fast | 1,000,000 | 128,000 |
| `claude-fable-5-1-medium` | Claude Fable 5.1 Medium | 1,000,000 | 128,000 |
| `claude-fable-5-1-low` | Claude Fable 5.1 Low | 1,000,000 | 128,000 |
| `claude-fable-5-1-high` | Claude Fable 5.1 High | 1,000,000 | 128,000 |
| `claude-fable-5-1-xhigh` | Claude Fable 5.1 XHigh | 1,000,000 | 128,000 |
| `claude-fable-5-1-max` | Claude Fable 5.1 Max | 1,000,000 | 128,000 |
| `claude-sonnet-5-medium` | Claude Sonnet 5 Medium | 1,000,000 | 128,000 |
| `claude-sonnet-5-low` | Claude Sonnet 5 Low | 1,000,000 | 128,000 |
| `claude-sonnet-5-high` | Claude Sonnet 5 High | 1,000,000 | 128,000 |
| `claude-sonnet-5-xhigh` | Claude Sonnet 5 XHigh | 1,000,000 | 128,000 |
| `claude-sonnet-5-max` | Claude Sonnet 5 Max | 1,000,000 | 128,000 |
| `gemini-3-8-flash-medium` | Gemini 3.8 Flash Medium | 1,048,576 | 65,535 |
| `gemini-3-8-flash-low` | Gemini 3.8 Flash Low | 1,048,576 | 65,535 |
| `gemini-3-8-flash-high` | Gemini 3.8 Flash High | 1,048,576 | 65,535 |
| `gpt-5-6-sol-medium` | GPT-5.6 Sol Medium Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-none` | GPT-5.6 Sol No Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-low` | GPT-5.6 Sol Low Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-high` | GPT-5.6 Sol High Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-xhigh` | GPT-5.6 Sol XHigh Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-max` | GPT-5.6 Sol Max Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-sol-none-priority` | GPT-5.6 Sol No Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-sol-low-priority` | GPT-5.6 Sol Low Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-sol-medium-priority` | GPT-5.6 Sol Medium Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-sol-high-priority` | GPT-5.6 Sol High Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-sol-xhigh-priority` | GPT-5.6 Sol XHigh Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-sol-max-priority` | GPT-5.6 Sol Max Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-medium` | GPT-5.6 Luna Medium Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-none` | GPT-5.6 Luna No Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-low` | GPT-5.6 Luna Low Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-high` | GPT-5.6 Luna High Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-xhigh` | GPT-5.6 Luna XHigh Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-max` | GPT-5.6 Luna Max Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-luna-none-priority` | GPT-5.6 Luna No Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-low-priority` | GPT-5.6 Luna Low Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-medium-priority` | GPT-5.6 Luna Medium Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-high-priority` | GPT-5.6 Luna High Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-xhigh-priority` | GPT-5.6 Luna XHigh Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-luna-max-priority` | GPT-5.6 Luna Max Thinking Fast | 1,000,000 | 128,000 |
| `gpt-6-astra-medium` | GPT-6 Astra Medium Thinking | 1,000,000 | 128,000 |
| `gpt-6-astra-low` | GPT-6 Astra Low Thinking | 1,000,000 | 128,000 |
| `gpt-6-astra-high` | GPT-6 Astra High Thinking | 1,000,000 | 128,000 |
| `gpt-6-astra-xhigh` | GPT-6 Astra XHigh Thinking | 1,000,000 | 128,000 |
| `gpt-6-astra-max` | GPT-6 Astra Max Thinking | 1,000,000 | 128,000 |
| `gpt-6-astra-low-priority` | GPT-6 Astra Low Thinking Fast | 1,000,000 | 128,000 |
| `gpt-6-astra-medium-priority` | GPT-6 Astra Medium Thinking Fast | 1,000,000 | 128,000 |
| `gpt-6-astra-high-priority` | GPT-6 Astra High Thinking Fast | 1,000,000 | 128,000 |
| `gpt-6-astra-xhigh-priority` | GPT-6 Astra XHigh Thinking Fast | 1,000,000 | 128,000 |
| `gpt-6-astra-max-priority` | GPT-6 Astra Max Thinking Fast | 1,000,000 | 128,000 |
| `glm-5-2` | GLM-5.2 High | 200,000 | 128,000 |
| `glm-5-2-max` | GLM-5.2 Max | 200,000 | 128,000 |
| `glm-5-2-1m` | GLM-5.2 High 1M | 1,000,000 | 128,000 |
| `glm-5-2-max-1m` | GLM-5.2 Max 1M | 1,000,000 | 128,000 |
| `glm-5-2-none` | GLM-5.2 No Thinking | 200,000 | 128,000 |
| `glm-5-2-none-1m` | GLM-5.2 No Thinking 1M | 1,000,000 | 128,000 |
| `kimi-k3-high` | Kimi K3 High | 1,048,576 | 131,072 |
| `kimi-k3-low` | Kimi K3 Low | 1,048,576 | 131,072 |
| `kimi-k3-max` | Kimi K3 Max | 1,048,576 | 131,072 |
| `glm-5-3-low` | GLM-5.3 Low | 1,048,576 | 128,000 |
| `glm-5-3-high` | GLM-5.3 High | 1,048,576 | 128,000 |
| `glm-5-3-max` | GLM-5.3 Max | 1,048,576 | 128,000 |
| `swe-1-7-lightning` | SWE-1.7 Lightning Max | 202,752 | 96,000 |
| `swe-1-7-lightning-medium` | SWE-1.7 Lightning Medium | 202,752 | 96,000 |
| `swe-2-high` | SWE-2 High | 262,000 | 128,000 |
| `swe-2-medium` | SWE-2 Medium | 262,000 | 128,000 |
| `swe-2-max` | SWE-2 Max | 262,000 | 128,000 |
| `claude-opus-4-7-medium` | Claude Opus 4.7 Medium | 1,000,000 | 128,000 |
| `claude-opus-4-7-low` | Claude Opus 4.7 Low | 1,000,000 | 128,000 |
| `claude-opus-4-7-high` | Claude Opus 4.7 High | 1,000,000 | 128,000 |
| `claude-opus-4-7-xhigh` | Claude Opus 4.7 XHigh | 1,000,000 | 128,000 |
| `claude-opus-4-7-max` | Claude Opus 4.7 Max | 1,000,000 | 128,000 |
| `claude-opus-4-8-medium` | Claude Opus 4.8 Medium | 1,000,000 | 128,000 |
| `claude-opus-4-8-low` | Claude Opus 4.8 Low | 1,000,000 | 128,000 |
| `claude-opus-4-8-high` | Claude Opus 4.8 High | 1,000,000 | 128,000 |
| `claude-opus-4-8-xhigh` | Claude Opus 4.8 XHigh | 1,000,000 | 128,000 |
| `claude-opus-4-8-max` | Claude Opus 4.8 Max | 1,000,000 | 128,000 |
| `claude-opus-4-8-low-fast` | Claude Opus 4.8 Low Fast | 1,000,000 | 128,000 |
| `claude-opus-4-8-medium-fast` | Claude Opus 4.8 Medium Fast | 1,000,000 | 128,000 |
| `claude-opus-4-8-high-fast` | Claude Opus 4.8 High Fast | 1,000,000 | 128,000 |
| `claude-opus-4-8-xhigh-fast` | Claude Opus 4.8 XHigh Fast | 1,000,000 | 128,000 |
| `claude-opus-4-8-max-fast` | Claude Opus 4.8 Max Fast | 1,000,000 | 128,000 |
| `claude-5-fable-low` | Claude Fable 5 Low | 1,000,000 | 128,000 |
| `claude-5-fable-medium` | Claude Fable 5 Medium | 1,000,000 | 128,000 |
| `claude-5-fable-high` | Claude Fable 5 High | 1,000,000 | 128,000 |
| `claude-5-fable-xhigh` | Claude Fable 5 XHigh | 1,000,000 | 128,000 |
| `claude-5-fable-max` | Claude Fable 5 Max | 1,000,000 | 128,000 |
| `gemini-3-5-flash-minimal` | Gemini 3.5 Flash Minimal | 1,048,576 | 65,535 |
| `gemini-3-5-flash-low` | Gemini 3.5 Flash Low | 1,048,576 | 65,535 |
| `gemini-3-5-flash-medium` | Gemini 3.5 Flash Medium | 1,048,576 | 65,535 |
| `gemini-3-5-flash-high` | Gemini 3.5 Flash High | 1,048,576 | 65,535 |
| `gemini-3-6-flash-minimal` | Gemini 3.6 Flash Minimal | 1,048,576 | 65,535 |
| `gemini-3-6-flash-low` | Gemini 3.6 Flash Low | 1,048,576 | 65,535 |
| `gemini-3-6-flash-medium` | Gemini 3.6 Flash Medium | 1,048,576 | 65,535 |
| `gemini-3-6-flash-high` | Gemini 3.6 Flash High | 1,048,576 | 65,535 |
| `gemini-3-7-flash-low` | Gemini 3.7 Flash Low | 1,048,576 | 65,535 |
| `gemini-3-7-flash-medium` | Gemini 3.7 Flash Medium | 1,048,576 | 65,535 |
| `gemini-3-7-flash-high` | Gemini 3.7 Flash High | 1,048,576 | 65,535 |
| `gpt-5-6-terra-none` | GPT-5.6 Terra No Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-low` | GPT-5.6 Terra Low Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-medium` | GPT-5.6 Terra Medium Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-high` | GPT-5.6 Terra High Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-xhigh` | GPT-5.6 Terra XHigh Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-max` | GPT-5.6 Terra Max Thinking | 1,000,000 | 128,000 |
| `gpt-5-6-terra-none-priority` | GPT-5.6 Terra No Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-terra-low-priority` | GPT-5.6 Terra Low Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-terra-medium-priority` | GPT-5.6 Terra Medium Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-terra-high-priority` | GPT-5.6 Terra High Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-terra-xhigh-priority` | GPT-5.6 Terra XHigh Thinking Fast | 1,000,000 | 128,000 |
| `gpt-5-6-terra-max-priority` | GPT-5.6 Terra Max Thinking Fast | 1,000,000 | 128,000 |
| `grok-4-5-low` | Grok 4.5 Low | 500,000 | 100,000 |
| `grok-4-5-medium` | Grok 4.5 Medium | 500,000 | 100,000 |
| `grok-4-5-high` | Grok 4.5 High | 500,000 | 100,000 |
| `grok-4-6-low` | Grok 4.6 Low | 500,000 | 100,000 |
| `grok-4-6-medium` | Grok 4.6 Medium | 500,000 | 100,000 |
| `grok-4-6-high` | Grok 4.6 High | 500,000 | 100,000 |
| `grok-4-6-xhigh` | Grok 4.6 XHigh | 500,000 | 100,000 |
| `inkling-none` | Inkling None | 1,048,576 | 131,072 |
| `inkling-low` | Inkling Low | 1,048,576 | 131,072 |
| `inkling-medium` | Inkling Medium | 1,048,576 | 131,072 |
| `inkling-high` | Inkling High | 1,048,576 | 131,072 |
| `inkling-xhigh` | Inkling X-High | 1,048,576 | 131,072 |
| `inkling-max` | Inkling Max | 1,048,576 | 131,072 |
| `glm-5-3-flash-low` | GLM-5.3 Flash Low | 1,000,000 | 128,000 |
| `glm-5-3-flash-high` | GLM-5.3 Flash High | 1,000,000 | 128,000 |
| `glm-5-3-flash-max` | GLM-5.3 Flash Max | 1,000,000 | 128,000 |
| `deepseek-v4-flash-high` | DeepSeek V4 Flash High | 1,048,576 | 384,000 |
| `deepseek-v4-flash-max` | DeepSeek V4 Flash Max | 1,048,576 | 384,000 |
| `deepseek-v4-1-flash-high` | DeepSeek V4.1 Flash High | 1,048,576 | 384,000 |
| `deepseek-v4-1-flash-max` | DeepSeek V4.1 Flash Max | 1,048,576 | 384,000 |
| `swe-1-7` | SWE-1.7 Max | 262,000 | 128,000 |
| `swe-1-7-medium` | SWE-1.7 Medium | 262,000 | 128,000 |
| `claude-opus-4-6` | Claude Opus 4.6 | 200,000 | 128,000 |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 Thinking | 200,000 | 128,000 |
| `claude-opus-4-6-1m` | Claude Opus 4.6 1M | 1,000,000 | 128,000 |
| `claude-opus-4-6-thinking-1m` | Claude Opus 4.6 Thinking 1M | 1,000,000 | 128,000 |
| `gpt-5-4-none` | GPT-5.4 No Thinking | 272,000 | 128,000 |
| `gpt-5-4-low` | GPT-5.4 Low Thinking | 272,000 | 128,000 |
| `gpt-5-4-medium` | GPT-5.4 Medium Thinking | 272,000 | 128,000 |
| `gpt-5-4-high` | GPT-5.4 High Thinking | 272,000 | 128,000 |
| `gpt-5-4-xhigh` | GPT-5.4 XHigh Thinking | 272,000 | 128,000 |
| `gpt-5-4-none-priority` | GPT-5.4 No Thinking Fast | 272,000 | 128,000 |
| `gpt-5-4-low-priority` | GPT-5.4 Low Thinking Fast | 272,000 | 128,000 |
| `gpt-5-4-medium-priority` | GPT-5.4 Medium Thinking Fast | 272,000 | 128,000 |
| `gpt-5-4-high-priority` | GPT-5.4 High Thinking Fast | 272,000 | 128,000 |
| `gpt-5-4-xhigh-priority` | GPT-5.4 XHigh Thinking Fast | 272,000 | 128,000 |
| `gpt-5-5-none` | GPT-5.5 No Thinking | 272,000 | 128,000 |
| `gpt-5-5-low` | GPT-5.5 Low Thinking | 272,000 | 128,000 |
| `gpt-5-5-medium` | GPT-5.5 Medium Thinking | 272,000 | 128,000 |
| `gpt-5-5-high` | GPT-5.5 High Thinking | 272,000 | 128,000 |
| `gpt-5-5-xhigh` | GPT-5.5 XHigh Thinking | 272,000 | 128,000 |
| `gpt-5-5-none-priority` | GPT-5.5 No Thinking Fast | 272,000 | 128,000 |
| `gpt-5-5-low-priority` | GPT-5.5 Low Thinking Fast | 272,000 | 128,000 |
| `gpt-5-5-medium-priority` | GPT-5.5 Medium Thinking Fast | 272,000 | 128,000 |
| `gpt-5-5-high-priority` | GPT-5.5 High Thinking Fast | 272,000 | 128,000 |
| `gpt-5-5-xhigh-priority` | GPT-5.5 XHigh Thinking Fast | 272,000 | 128,000 |
| `gpt-5-4-mini-low` | GPT-5.4 Mini Low Thinking | 400,000 | 128,000 |
| `gpt-5-4-mini-medium` | GPT-5.4 Mini Medium Thinking | 400,000 | 128,000 |
| `gpt-5-4-mini-high` | GPT-5.4 Mini High Thinking | 400,000 | 128,000 |
| `gpt-5-4-mini-xhigh` | GPT-5.4 Mini XHigh Thinking | 400,000 | 128,000 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 200,000 | 128,000 |
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6 Thinking | 200,000 | 128,000 |
| `claude-sonnet-4-6-1m` | Claude Sonnet 4.6 1M | 1,000,000 | 128,000 |
| `claude-sonnet-4-6-thinking-1m` | Claude Sonnet 4.6 Thinking 1M | 1,000,000 | 128,000 |
| `MODEL_GPT_5_2_LOW` | GPT-5.2 Low Thinking | 384,000 | 128,000 |
| `MODEL_GPT_5_2_MEDIUM` | GPT-5.2 Medium Thinking | 384,000 | 128,000 |
| `MODEL_GPT_5_2_NONE` | GPT-5.2 No Thinking | 384,000 | 128,000 |
| `MODEL_GPT_5_2_HIGH` | GPT-5.2 High Thinking | 384,000 | 128,000 |
| `MODEL_GPT_5_2_XHIGH` | GPT-5.2 XHigh Thinking | 384,000 | 128,000 |
| `MODEL_CLAUDE_4_5_OPUS` | Claude Opus 4.5 | 200,000 | 64,000 |
| `MODEL_CLAUDE_4_5_OPUS_THINKING` | Claude Opus 4.5 Thinking | 200,000 | 64,000 |
| `MODEL_PRIVATE_11` | Claude Haiku 4.5 | 200,000 | 64,000 |
| `MODEL_PRIVATE_2` | Claude Sonnet 4.5 | 200,000 | 64,000 |
| `MODEL_PRIVATE_3` | Claude Sonnet 4.5 Thinking | 200,000 | 64,000 |
| `MODEL_CHAT_GPT_4_1_2025_04_14` | GPT-4.1 | 1,047,576 | 32,768 |
| `MODEL_PRIVATE_12` | GPT-5.1 No Thinking | 272,000 | 128,000 |
| `MODEL_PRIVATE_13` | GPT-5.1 Low Thinking | 272,000 | 128,000 |
| `MODEL_PRIVATE_14` | GPT-5.1 Medium Thinking | 272,000 | 128,000 |
| `MODEL_PRIVATE_15` | GPT-5.1 High Thinking | 272,000 | 128,000 |
| `gpt-5-3-codex-low` | GPT-5.3-Codex Low | 400,000 | 128,000 |
| `gpt-5-3-codex-medium` | GPT-5.3-Codex Medium | 400,000 | 128,000 |
| `gpt-5-3-codex-high` | GPT-5.3-Codex High | 400,000 | 128,000 |
| `gpt-5-3-codex-xhigh` | GPT-5.3-Codex X-High | 400,000 | 128,000 |
| `gpt-5-3-codex-low-priority` | GPT-5.3-Codex Low Fast | 400,000 | 128,000 |
| `gpt-5-3-codex-medium-priority` | GPT-5.3-Codex Medium Fast | 400,000 | 128,000 |
| `gpt-5-3-codex-high-priority` | GPT-5.3-Codex High Fast | 400,000 | 128,000 |
| `gpt-5-3-codex-xhigh-priority` | GPT-5.3-Codex XHigh Fast | 400,000 | 128,000 |
| `kimi-k2-6` | Kimi K2.6 | 262,144 | 8,192 |
| `kimi-k2-7` | Kimi K2.7 | 262,144 | 16,000 |
| `nemotron-3-ultra-none` | Nemotron 3 Ultra None | 1,000,000 | 32,768 |
| `nemotron-3-ultra-medium` | Nemotron 3 Ultra Medium | 1,000,000 | 32,768 |
| `nemotron-3-ultra-high` | Nemotron 3 Ultra High | 1,000,000 | 32,768 |
| `swe-1-6` | SWE-1.6 | 200,000 | 128,000 |
| `swe-1-6-fast` | SWE-1.6 Fast | 200,000 | 128,000 |
| `gemini-3-1-pro-low` | Gemini 3.1 Pro Low Thinking | 1,048,576 | 65,535 |
| `gemini-3-1-pro-high` | Gemini 3.1 Pro High Thinking | 1,048,576 | 65,535 |
| `MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL` | Gemini 3 Flash Minimal | 1,048,576 | 65,535 |
| `MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW` | Gemini 3 Flash Low | 1,048,576 | 65,535 |
| `MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM` | Gemini 3 Flash Medium | 1,048,576 | 65,535 |
| `MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH` | Gemini 3 Flash High | 1,048,576 | 65,535 |
| `deepseek-v4-pro-high` | DeepSeek V4 Pro High | 1,048,576 | 384,000 |
| `deepseek-v4-pro-max` | DeepSeek V4 Pro Max | 1,048,576 | 384,000 |
</details>

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Listening address |
| `DEVIN_API_KEY` | Unset | Optional fallback token used only when a request omits `Authorization`/`x-api-key` |
| `DEVIN_BASE_URL` | Unset | Override for the Devin API base URL |

## API examples

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer devin-session-token$xxxx' \
  -d '{"model":"claude-opus-4-8-low","messages":[{"role":"user","content":"Hello"}]}'
```

Streaming response:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5-5-none","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

### Anthropic Messages

```bash
curl http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: devin-session-token$xxxx' \
  -d '{"model":"claude-opus-4-8-low","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

## Programmatic usage

The gateway is also importable as a TypeScript library, so GitHub Actions or other scripts can call Devin directly without going through the HTTP server.

```ts
import { chat, listModels } from "devin-gateway";

const { text, toolCalls, finishReason } = await chat({
  token: process.env.DEVIN_TOKEN, // or set DEVIN_API_KEY
  model: "claude-opus-4-8-low",
  messages: [{ role: "user", content: "Summarize this PR" }],
});

for (const m of listModels()) console.log(m.id, m.contextWindow);
```

Importing the package does **not** start the server. To run the server programmatically:

```ts
import { startServer } from "devin-gateway";
const handle = await startServer({ port: 3000 });
// ... later
await handle.stop();
```

`chat()` only needs the Bun runtime when reading the token file; pass `token` explicitly and it runs under plain Node.js too, which makes it suitable for GitHub Actions runners. Lower-level building blocks (`streamChat`, `discoverModels`, `getUserJwt`, converters, model catalog) are all re-exported from the package entry point. The server can hold an optional fallback credential in memory; clients may still send credentials per request.

## GitHub Actions

A reusable workflow at `.github/workflows/devin-chat.yml` turns Devin into a model provider for any repository's CI — no HTTP server, no port management. Pass the token via `secrets` and the prompt via `with`, then read the reply from job outputs.

See **[docs/github-actions.md](docs/github-actions.md)** for the full guide: inputs, outputs, secret setup, and ready-to-use examples (PR review, commit message generation, multi-step pipelines). A Chinese version is available at **[docs/github-actions.zh-CN.md](docs/github-actions.zh-CN.md)**.

## Architecture

```text
Client (Cherry Studio, etc.)
    │  OpenAI / Anthropic format
    ▼
Devin Gateway (Bun + handwritten Protobuf)
    │  Connect protocol (Protobuf over HTTP)
    ▼
Devin / Windsurf Cascade API
```

Key files:

- `src/proto.ts`: minimal Protobuf codecs for the required messages
- `src/devin.ts`: Devin API client for GetUserJwt and streaming GetChatMessage
- `src/models.ts`: model catalog and workload routing
- `src/convert.ts`: conversion between OpenAI, Anthropic, and Devin formats
- `src/config.ts`: token file read/write helpers and startup fallback-token lookup
- `src/login.ts`: OAuth PKCE login flow
- `src/cli/login.ts`: command-line login tool
- `src/server.ts`: HTTP server and compatibility endpoints
- `src/client.ts`: high-level `chat()` client for programmatic/Actions use
- `src/index.ts`: public entry point — re-exports the API, starts the server when run directly

## Web model picker (Phase 2)

Open `http://127.0.0.1:38644/admin/` through an SSH tunnel. The page never handles Devin credentials and is not served on the inference port. Its fixed assets use a same-origin CSP without inline scripts, inline styles, or eval. No external fonts, analytics, or CDN assets are loaded.

The compact dark picker adapts Cody's MIT-licensed category, display and pagination helpers; attribution is in `web/model-picker/THIRD_PARTY_NOTICES.txt` and the built `/admin/assets/third-party-notices.txt`. React/React DOM are the only added runtime dependencies. Bun bundles the frontend; no Next.js or separate UI server is required:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Search matches exact IDs and display names case-insensitively. SWE, Fusion and Other are display categories only, combined as a union. Pages contain at most 60 rows; bulk actions affect every filtered row across pages. The enabled-only filter uses the unsaved draft.

Checkboxes, role assignments and the future-model policy share one draft. Save sends one complete selection using the loaded ETag, `If-Match`, and `X-Devin-Management: 1`. Cancel or Escape discards the whole draft; Escape first closes an open category filter. A 412 preserves the draft and blocks overwrite until explicit reload. Both Phase 1 roles remain required: disabling an assigned model blocks Save until it is re-enabled or reassigned. Only available, enabled models with reviewed profiles and complete export metadata can receive roles. Unreviewed models can be enabled but cannot receive a Codex role.

The future-model option requires all discovered models to be selected. Disabling any model exits future mode. New discoveries may join the enabled selection but never acquire a role automatically. Missing upstream models remain visible as unavailable; no substitute is selected.

### Logical families and effort routing (Phase 2.5)

Discovery decodes `ClientModelConfig` fields 30/31, including family label, effort entries, Fast/1M dimensions and both upstream default markers. Families derive from this authoritative metadata, not UID suffixes. A reviewed exact-ID fallback groups only the known SWE-2 Medium/High/Max IDs when family metadata is absent. Defaults are reported separately and never change the saved Medium worker role. Off exists only when metadata identifies a genuine non-reasoning member.

The picker groups concrete effort variants under a logical family. Checkboxes still save exact concrete IDs, so partial-family selections remain precise. Role controls separately select an enabled, available, structurally compatible model/effort. Live-tested history is informational, not an export gate. The Codex manifest exports only selected compatible efforts with exact effort-to-concrete `routing` maps. Fast and 1M lanes never share routes with standard lanes.

For Responses, `model: "swe-2"` plus `reasoning: {"effort":"medium"}` routes to `chatModelUid: "swe-2-medium"`. Missing/unsupported effort is a 400, never an upstream default substitution. Chat Completions uses `reasoning_effort`; Anthropic has no equivalent explicit effort here and rejects recognized logical families rather than guessing from a token budget. Direct concrete IDs keep their wire ID unchanged. Legacy unrecognized direct IDs still pass through; family identities are established by discovery or the reviewed exact-ID registry, never naming guesses. Recognized removed/unavailable families fail closed. `DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM=1` applies the proven exact-content system/developer placement transformation provider-wide on Devin Responses requests, independently of the resolved model ID. Absent/zero disables it; no model allowlist or temporary test flag remains. See [Desktop operator notes](tools/codex-devin/README.md) for fresh-thread testing and upstream-provider outage classification.

Initialization atomically migrates a valid v1 file to v2 without advancing its revision. It first preserves the original bytes as private `model-selection.v1.json`. A conflicting existing backup, invalid original, or ambiguous family fails closed. The v2 ETag is `"model-selection-v2-<revision>"`, so old v1 clients cannot overwrite migrated settings. To reverse a migration, stop all settings writers, archive any newer v2 selection, and restore the original v1 bytes from that private backup before running the old gateway. Never touch the auth volume.

Phase 3 remains unimplemented. Dynamic catalog/worker generation and a reviewed Windows source-pin refresh require separate approval. No live model access or Linux migration acceptance is implied by offline tests.

**Phase 3 is not implemented:** Windows activation still uses its validated static catalog/worker. Saving here does not change Desktop configuration. Runtime/package changes require a separately reviewed Windows source-fingerprint refresh before using the local launcher; its guard has not been bypassed.

After review and publication of this branch, deploy without removing auth/settings volumes:

```sh
cd <existing-gateway-checkout>
git fetch origin
git switch feat/model-picker-phase2
git pull --ff-only
sudo docker compose build devin-gateway
sudo docker compose up -d --no-deps --force-recreate devin-gateway
sudo docker compose ps
```

From a standalone Windows terminal:

```powershell
ssh.exe -N -o ExitOnForwardFailure=yes -L 127.0.0.1:38644:127.0.0.1:38644 -i '<ssh-key-path>' '<ssh-user>@<private-host>'
```

Manual acceptance should verify search/filter/page-wide bulk changes, Cancel, required-role errors, future mode, and a conflict between two browser tabs. Confirm `/admin/` remains absent on inference port 38643 and management port 38644 is not LAN-published. Do not submit an inference request for this acceptance.

## License

Released under the [MIT License](LICENSE).
