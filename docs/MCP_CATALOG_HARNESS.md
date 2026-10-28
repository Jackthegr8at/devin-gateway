# Bounded Codex CLI catalog controller

The native Desktop session controls `scripts/mcp-catalog-harness.ts`. It launches
the installed CLI as a separate child; Desktop stays running. It never deploys
or restarts services. No persistent Codex settings are changed.

Verified installed CLI: 0.164.0-alpha.11.1. `exec --help` confirms `--json`,
`--ephemeral`, sandbox selection and `-c` overrides; `features list` confirms
`apps` and `unbounded_connection_retries`. No approval bypass or ignore-rules
flags are used. The harness tightens shell sandboxing to read-only. MCP still
runs in Codex with its normal security/approval flow.

Every child invocation sets `mcp_servers.memory.required=true`. In this CLI
version, optional stdio MCP startup can still be in flight when `exec` sends its
first Responses request. The interactive TUI had time to finish discovery before
the user submitted the task. Requiring Memory awaits its initialization and tool
discovery or fails closed; it does not grant approval or alter credentials.
Both offline catalog preflight and the live child use this same override. A
configured server or successful `mcp list` alone is never a preflight pass:
`selectDiagnosticCatalog` must find all six functions in the actual outbound
Responses declarations.

## Operation

First run offline startup/catalog probes (local mock only, no Devin inference):

```powershell
bun run scripts/mcp-catalog-harness.ts --probe --cli '<path-to-codex.exe>'
```

Then, only when both probes report all six Memory tools:

```powershell
bun run scripts/mcp-catalog-harness.ts --run --max-runs 12 --cli '<path-to-codex.exe>'
```

After separately authorizing/deploying the extended diagnostic selector, add
`--isolate` to enable namespace and range isolation. The same 12-run cap covers
the initial comparisons and all subsequent searches. Tests are always sequential.
Each CLI test has a 120-second deadline and at most three Responses requests;
provider retries are disabled. Ctrl+C cancels only the harness child tree and
its outstanding proxy requests. It never stops Desktop or production.

Initial comparisons use identical SWE-2/medium settings and a fixed read-only
Memory prompt, with a unique correlation marker per test: Memory-only/apps-on,
Memory-only/apps-off, full/apps-off, full/apps-on. A local in-memory proxy
permits only `memory.recall_memory` tool calls to reach Codex. Shell, Memory
mutations, unrelated tool calls and unknown actions stop the batch before being
forwarded to Codex. At most one distinct recall call ID is allowed per test;
repeated SSE lifecycle events for that same call do not count as new calls.
The CLI sees actual approved MCP results; the harness does
not execute MCP itself. Raw CLI output, request bodies and Memory data are
discarded. `--ephemeral` prevents test rollout persistence by the CLI.

The proxy checks all six Memory declarations before forwarding any generation
request. If missing, it stops; a full-catalog test without Memory would not be
a valid comparison. Preliminary GET `/v1/models` is read-only discovery, not a
generation. Tool catalog probes report candidate counts, never claim those
counts were sent to Devin.

## Extended selector (default off)

The existing `x-devin-diagnostic-tool-catalog` header now additionally accepts:

- `memory+group:ns.mcp__codex_app`: six Memory tools plus one namespace.
- `memory+group:native`: Memory plus unnamespaced functions.
- `memory+group:ns.mcp__codex_app@0-7`: a namespace's ordinal subset.
- `memory+range:0-31`: an ordinal subset of all non-Memory functions.

Ordinal indices are inclusive, sorted by the original `[namespace, name]`
identity using locale-independent string order, before catalog selection.
Schemas, names, strict flags and identities are never rewritten. The selection
covers merged top-level/additional declarations and the final executable catalog.
Unknown/empty groups, invalid ranges and missing Memory fail before generation.
No header leaves normal behavior unchanged. Guardian ignores inherited selectors.

Isolation tests each group, then explores both halves of every failing group to
allow multiple incompatible tools. If all groups pass independently and the full
catalog fails, remaining budget searches prefixes. A minimal failing prefix is
not proof of a numeric threshold: cross-tool interactions may explain it.
Changes in actual tool count during a test stop the batch rather than comparing
different catalogs. Unresolved ranges remain unresolved when budget expires.

## Evidence and storage

Only sanitized summaries are appended under untracked
`deploy/operator/test-results/`: test ID, selection, actual tool counts, result,
fixed error classification, gateway request IDs and numeric upstream statuses.
Gateway records are correlated by SHA-256 of normalized user text, including
the unique marker; hashes and raw text are not saved in test summaries.
HTTP 200 is never a pass. A pass requires a CLI-completed Memory recall, a
gateway-emitted call, a returned tool result, successful continuation and CLI
completion. Unexpected errors, missing correlation, timeout, unsafe behavior or
missing baseline stop further testing. Expected `permission_denied` is evidence
for isolation, not success.

## Current evidence (2026-10-26)

Production baseline verified at `faf1801`; the previous interactive test's safe
gateway records show six-tool completed requests. The first automated startup
was stopped at unexpected preliminary model discovery. After handling that
read-only GET, an automated request was rejected before generation because
Memory was missing (gateway request `b3b745ff`, conversion failure, zero upstream
HTTP requests). No live Devin generation was started by this batch.

Initial offline child probes showed 81 candidate functions with apps enabled
and 23 with apps disabled, both without Memory. A follow-up app-server
`config/read` confirmed Memory configured/enabled; `mcpServerStatus/list` returned
all six functions with no discovery error. Controlled local-mock comparisons
then confirmed that either `mcp_servers.memory.required=true` or a 10-second
optional startup grace makes all six appear in `exec`'s first outbound catalog.
The harness uses the required-server override, not the timing-based workaround.
Enabling the server explicitly or changing read-only to workspace-write did not
resolve the omission; no sandbox/approval bypass was needed.

The interactive success and automated probes use the same installed CLI version
0.164.0-alpha.11.1. The successful TUI session ran from this gateway checkout,
with the `memory_isolation` provider and medium effort. Changing the automated
cwd or Desktop routing environment names did not fix the omission. The
per-invocation required-server override did, with the harness's existing cwd,
provider, sandbox and inherited environment unchanged. Other optional MCP tools
can now finish discovery too, so old 81/23 counts must not be treated as current
catalog counts or numeric limits.

The installed app-server's initialize/config responses confirm the effective
home `<user-home>/.codex` and user file `<user-home>/.codex/config.toml`.
Neither Memory's required flag nor the optional-startup grace is set explicitly
in that configuration. Post-fix outbound preflights show all six Memory
functions with Apps on (294 candidate functions) and off (236). These are local
mock observations, not tool counts sent to Devin. The process-local flag also
leaves the harness's existing sandbox, approval handling and retry budget intact.

No new failing declaration or numeric limit has been identified. Group testing
remains unrun and requires the previously prepared selector deployment to be
explicitly authorized. This startup correction is CLI-only and needs no gateway
deployment. Follow-up verification uses a local rejecting mock, never Devin
inference or MCP `tools/call`.
