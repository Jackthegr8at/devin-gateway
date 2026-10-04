# Native V1 multi-agent lifecycle audit

## Scope and evidence

This audit changes tests and documentation only. No live inference, real child
creation, activation, OAuth, deployment, selection or Tested-state mutation was
performed. Disposable test stores contain only synthetic data.

Gateway sources: `src/convert.ts`, `src/devin.ts`, `src/server.ts`,
`src/responses-diagnostics.ts`, `src/admin/model-test-status.ts`.

Codex contract reference: the locally available OpenAI Codex source snapshot
`8e68a98ef03cdde76d2e6800791ebdf1b3b95b24` (workspace version `0.159.1`).
Relevant source paths are `codex-rs/core/src/tools/handlers/multi_agents/`,
`multi_agents_spec.rs`, `multi_agents_common.rs`,
`codex-rs/core/src/agent/control/{legacy,resume}.rs`,
`codex-rs/core/src/agent/status.rs` and `codex-rs/protocol/src/thread_id.rs`.
This is a source-level reference, **not proof of the installed Desktop build's
exact contract**. In particular, newer/older Desktop declarations may use
different target field names. The gateway forwards the actual incoming schema;
it must not rewrite arguments based on this snapshot. Tests use synthetic
contract-shaped outputs and do not emulate or verify Codex execution.

## Bridge path: identical for all five operations

`namespace=multi_agent_v1` plus one of `spawn_agent`, `send_input`, `wait_agent`,
`resume_agent`, `close_agent` is accepted by `responsesToolsetToDevin`.
The wire name is `multi_agent_v1__<name>`. Parameters/strict and agent descriptions
are forwarded unchanged. Only the separate flat `exec_command` has description
normalization. Unknown namespaces/functions remain filtered.

`streamChat` yields upstream tool-call deltas. The Responses collector preserves
the opaque call ID, merges same-ID cumulative/fragmented arguments and rejects
multiple distinct calls in one response. `finishResponsesToolCalls` checks the
declaration; `responsesFunctionCallItem` checks object JSON and restores the
namespace/name. Its generated item ID is not the upstream call ID.

Codex, **not the gateway**, executes the operation. The returned
`function_call_output` has an exact call ID and opaque output string.
`responsesInputToOpenAIMessages` -> `openaiToInternal` -> `toDevinPrompts` recreates
assistant calls (source 2) and tool results (source 4) in input order, including
replayed prior results. Every request uses the client-supplied full history;
there is no gateway child registry or server-side conversation store.

## Identities and privacy

| Identity | Owner / meaning | Boundary |
| --- | --- | --- |
| Upstream call ID | Devin; one tool invocation | Exact opaque string; correlation validates at most 4096 UTF-8 bytes, well-formed/nonblank/no control characters, credential collision checks. Not logged raw. |
| Responses item ID | Gateway; output envelope | Distinct from call ID; never an agent target. |
| Child agent/thread ID | Codex runtime; returned by spawn | Source reference generates UUIDv7 and parses UUID strings; not a gateway-generated ID. Remains inside private arguments/results. |
| Parent/child edge | Codex runtime | Parent thread, parent turn and root turn metadata belong to Codex, not gateway correlation. |
| Submission ID | Codex send-input result | Not a call ID or an agent ID. |
| Cascade ID | Gateway request reconstruction | Fresh per request; not a durable parent/child identity. |
| Credential scope | Gateway memory-only digest | Private correlation scope, not logged credentials. |

Transport validation and evidence validation are separate: the input bridge
requires nonempty call IDs and object JSON arguments; it does not impose a UUID
format on provider call IDs or interpret agent IDs. Codex validates agent targets.
Agent IDs are not established as safe public identifiers; no new identifier logs
were added. Safe diagnostics use tool names, counts, stages and fixed categories,
not child prompts/responses/arguments/outputs/call IDs/agent IDs.

## Source-confirmed V1 operation semantics

| Operation | Arguments in source snapshot | Result / behavior |
| --- | --- | --- |
| spawn_agent | message or items, optional agent_type/model/reasoning_effort/fork_context | `{agent_id,nickname}` after child creation; role/model/depth checks can return errors before creation. |
| send_input | target, message or items, optional interrupt (false) | `{submission_id}`; repeated sends are allowed. Interrupt requests interruption before submission; return is not a completed child result. |
| wait_agent | nonempty targets array, optional positive timeout_ms | `{status:{target:AgentStatus},timed_out}`; default 30000 ms, positive timeout clamped to configured min/max. Returns when a target becomes final or timeout occurs. Empty status and timed_out=true is pending, not failure. Repeated waits are valid. Unknown UUID target can return not_found; malformed ID is a tool error. |
| resume_agent | id | `{status:AgentStatus}`; returns existing loaded runtime or resumes from a saved rollout. It does not create an arbitrary unknown child; missing persisted thread fails. |
| close_agent | target | `{previous_status:AgentStatus}`; closes target and live descendants, marks persisted edge closed. Known unloaded/already-closed targets can close idempotently; unknown targets can error. Result/error still travels as normal function_call_output. |

Final statuses in this reference exclude pending_init, running and interrupted.
Completed/errored/shutdown/not_found are terminal. A completed tool operation
does not necessarily mean the child task completed successfully.

## Cancellation and orphans

Gateway JSON/SSE request cancellation aborts its upstream HTTP work; the gateway
never issues an implicit `close_agent`. The deterministic server test cancels a
continuation containing synthetic spawn history and proves upstream cancellation
without a second cleanup request. It cannot prove real child shutdown.

The source reference explicitly closes descendants through Codex close/shutdown
operations. That does **not** establish that cancelling a parent inference turn
or closing the Desktop UI automatically performs that operation. Treat a child
as potentially still active after interruption; inspect native child state and
explicitly close that exact child before ending acceptance. Do not assume an HTTP
disconnect cleans up the runtime or deletes its persisted thread history.

## Automatic Tested interaction

Correlation is tool-name agnostic: credential scope + exact call ID + resolved
concrete model + effort + completed upstream 200 continuation are necessary.
It also requires `returnedToolSucceeded`. Ordinary native results
`{agent_id}`, `{submission_id}`, `{status:{...},timed_out}`, `{status:"running"}`,
`{previous_status}` do **not** satisfy that predicate. Neither a successful spawn
nor a completed wait therefore automatically promotes Tested from those shapes.
An explicit accepted `{status:"success"}` or exit-code envelope could qualify
regardless of tool name; that describes existing generic policy, not a native
Codex result and not permission to manufacture such an envelope.

No policy change is proposed without a separate review. Agent failures/pending
results remain usable model context even though they are not Tested evidence.
Consumed outputs replay as no_issued_call; new invocation IDs remain independent.
Child IDs cannot satisfy a pending invocation ID.

The existing first-16-valid-returned-output evidence cap is unchanged. All output
history is forwarded, but later valid outputs beyond the cap are not considered
for promotion. Correlation lacks a thread ID: equal scope/call/model/effort tuples
across threads are not separately isolated. Do not claim cross-thread isolation.

## Offline coverage and remaining live boundary

Existing coverage includes all five namespace restorations, generic conversion,
sequential JSON/SSE loops, failed continuations, correlation scope/model/effort
isolation, opaque IDs, first-16 boundary, and downstream disconnect propagation.

New tests cover JSON and SSE spawn/wait/final; repeated sends; pending/completed
waits; close/resume; malformed target output; distinct target histories; mixed
exec/agent history; replayed spawn/wait outputs; failures after spawn and during
wait continuation; close after failure; same-ID upstream deltas; complete ordered
wire history; private diagnostic absence; no accidental Tested promotion; and
agent-ID versus call-ID isolation. Mock failure cleanup is an explicitly supplied
next request, not automatic recovery invented by the gateway.

No production bridge bug was exposed. Basic single-child execution has since
passed manual acceptance, as recorded below. Exact current target schemas,
two-sibling execution and cancellation/orphan behavior remain manual boundaries.
Do not enable parallel parent tool calls or nested agents.

## Single-child manual acceptance (passed)

The operator validated the SWE-2 High native lifecycle in a fresh Desktop thread:
exactly one child was created, waited for, and explicitly closed before the parent
returned final text. No visible orphan remained. No raw child IDs, call IDs,
prompts or child output are recorded here.

Safe diagnostics corroborated ordered spawn -> spawn output -> wait -> wait
output -> close -> close output -> final text. The close-request history had two
assistant calls and two outputs and emitted one further call. The final request
had three assistant calls and three outputs, emitted no further call, and
completed successfully. Ordinary native result objects still produce the expected
`tool_result_not_successful`; `unknown_tool` is the known nameless function-output
history fallback, not an extra invocation. Neither interpretation changes Tested.

Use the existing guarded worker workflow after manually closing Desktop. Keep
the saved parent/worker/provider/effort/security settings. Manually launch Desktop
in a fresh parent thread and request:

> Spawn exactly one native swe_worker. Ask it to read only the root package.json
> and return its package name. Wait for that same worker, explicitly close that
> same worker, then report its result. Do not spawn additional or nested workers
> or edit files. Do not read the file or run a local command in the parent.

Verify a genuine native child, exact parent/child models and provider, ordered
spawn result -> wait result -> explicit close -> final response. Inspect safe
counts/stages, not raw identifiers or child content. Pending waits may repeat;
close the same child on failure/cancellation, without spawning a replacement.
Then manually close Desktop and verify guarded byte/hash restoration. A lifecycle
pass need not modify Tested status under the current output-success predicate.

## Validation for this audit

- New lifecycle/evidence tests: 24 passed, 0 failed (JSON and SSE).
- Full Bun suite: 508 passed, 18 skipped, 1 documented upstream Windows SIGTERM
  failure; 527 tests across 34 files, 5533 assertions.
- Three no-emit TypeScript configurations and production TypeScript/web build:
  passed. The production output required sandbox-approved access to ignored
  build artifacts; no source permissions or runtime security were changed.
- All seven PowerShell suites passed (204 assertions), including selection.
- The earlier selection failure was a Windows PowerShell test-fixture encoding
  issue, not an obsolete equality requirement or a production contract failure.
  Reading the BOM-less UTF-8 generated catalog with default ANSI decoding before
  the alias probe changed both instruction fields from 18043 bytes / pinned
  SHA-256 `b707476816bfe5e571a1bd2179f130fff2b132da5ab8e61063acdb7fd24daf12`
  to 18058 bytes / SHA-256
  `ac421f8890204ca4af56069b0e6f39a14e7a2b06d83f2d5248de4ce236f72036`.
  The test now reads that fixture explicitly as UTF-8. The complete equality
  assertion and production contract v1 remain unchanged. Desktop backend
  `0.160.0` passes provenance, generated-catalog acceptance, exact model/effort
  metadata, reviewed shell alias, provider/security and recovery checks offline.
- All 15 PowerShell script/module ASTs, entrypoint shell syntax,
  `git diff --check`, and changed-file privacy checks passed.
- Existing source fingerprint inputs are unchanged. These test/documentation
  changes require no gateway deployment. Single-child live acceptance subsequently
  passed; two-sibling live acceptance has not been performed.

## Next acceptance: two sibling identities (design/offline only)

Keep parent operations sequential and upstream parallel tool calls disabled.
Two live children are runtime concurrency, not two calls in one provider response.
Expected sequence: spawn A -> spawn B -> wait only A -> receive A -> wait only B
-> receive B -> close only A -> close only B -> final response. Retain the private
spawn results as separate targets; never substitute a call/item ID for a child ID.
No nesting, parent-side command, or send_input is needed for these read-only tasks.

Installed backend discovery reports `0.160.0`; no runtime or active config was
changed. Its offline selection contract passes, but that probe does not export
the native spawn/wait declarations. The available source reference is `0.159.1`,
not an exact-source match for the installed binary: it permits multiple siblings
(V1 default thread capacity six) and `wait_agent.targets=[one child ID]`. Current
[official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
also describes concurrently open child threads and targeted orchestration, but
is not a version pin. No explicit thread-cap override was found in the active
user config. Thus sibling support is supported by source/docs, while the exact
installed declaration/capacity remains a live preflight boundary. Use the
runtime-supplied schema; if spawning B returns a limit/schema error, close A and
stop rather than changing permissions/config or falling back to another role.

Offline JSON/SSE fixtures now preserve two distinct spawn results, per-target wait
results, both wait/close order permutations, closing either sibling before waiting
for the other, one failed/one completed child, and explicit cleanup after upstream
failure with two active children. Every request compares the entire ordered wire
history and verifies disabled parallel calls. These are transport tests, not an
implementation of the Codex child registry. A deterministic disconnect test with
two synthetic active children proves upstream abort without invented cleanup.
Independent close-call evidence also verifies reversed returns and consumed replay
cannot consume the other pending call or promote native output to Tested.

For manual identity isolation, give A only the root package name task and B only
the root packageManager task. Keep the distinction in the private parent/child UI;
do not add these values or target IDs to diagnostics. Safe tool names/counts and
final completion corroborate transport, but cannot alone prove which child closed.
Inspect the native tool result and both child tabs for explicit close completion.

On any child failure, explicitly close both successfully created children; if B
was never created, close only A. Pending waits may repeat for that same target.
If the parent errors or acceptance is aborted, use the same parent thread to ask
it to close the already-created children without spawning replacements. Retain
their identities privately from the original spawn results. Do not assume gateway
cancellation or closing Desktop closes either child. No verified standalone shell
cleanup command is available; if the native parent cannot resume, report cleanup
as unresolved rather than claiming the children were closed. Never delete session
history or recovery evidence as a substitute for native close.

Validation for the sibling coverage: 44 focused tests passed; full Bun 528 passed,
18 skipped, with only the documented upstream Windows SIGTERM failure (547 tests,
34 files, 7002 assertions). Production behavior and diagnostic fields are unchanged.
