# Cross-provider Responses history

The gateway converts visible historical messages, reasoning summaries, function
calls/results, custom calls/results, and `additional_tools` declarations. User
images retain their existing validated data-URL transport. History conversion
does not execute any call or grant permission to invoke a historical tool again.
Only validated current function declarations are forwarded to Devin; emitted
calls must match a declaration in the current request.

## Codex MCP forwarding

The installed backend's observed MCP declaration shape is a `namespace` with
`function` children carrying `name`, `description`, `parameters` and `strict`.
The bridge accepts these groups and flat function declarations, including
`mcp__server__tool` names, from top-level tools and `additional_tools`.
Input object JSON schemas and strict flags are transported without rewriting.
Function namespaces are not restricted to the old native-tool allowlist.

Names requiring normalization use stable bounded hash identifiers with an
explicit collision check and a request-local inverse identity map. Existing
`exec_command` and five `multi_agent_v1` wire names are retained. Returned calls
restore the exact Codex namespace/name and call ID; follow-up history uses the
same mapped identity and preserves the result ID. Identical declarations are
deduplicated; conflicting declarations fail.

Codex executes the returned call using its existing MCP connection, approval and
sandbox controls. The gateway never contacts MCP servers, loads MCP credentials,
or executes tools. Unsupported live tool kinds (including hosted `mcp` tools and
custom executable tools), malformed declarations and non-object input schemas
fail explicitly. Old custom declarations inside historical `additional_tools`
are context only and remain inert, rather than acquiring execution support.

The exact native hosted `web_search` declaration is excluded from executable
tools and adds an explicit unavailability notice to the model's instructions.
It does not affect MCP functions. Explicit `tool_choice: {type: "web_search"}`
fails before generation, as does `required` when no executable tool remains.
No search substitute is provided; other unsupported native tool types still
fail explicitly, and model-generated undeclared search calls remain rejected.

Memory/AutoMem function declarations can use this path when Codex supplies them.
Offline JSON/SSE tests cover declarations, identity mapping, tool choice and the
client-result round trip. A live Codex session still needs to confirm that the
actual AutoMem catalog is supplied, approval/execution succeeds on the client,
and the model continues after a read-only memory lookup. No live inference or
MCP execution was performed during implementation. The existing one-call-per-
response limit and explicit rejection of non-text tool results remain unchanged.

In non-Guardian Devin prompts, unavailable historical calls and their matching
results become assistant text labeled as historical data, not instructions or
executable requests. JSON envelopes preserve the name, call ID, raw custom input
or original function-argument string, output content, and chronological order.
Association uses call IDs, including when calls/results are interleaved. Custom
input is not treated as a compatible function-call schema merely because its
name matches a current function. Ambiguous reused call IDs fail explicitly.
Currently declared compatible function history stays structured. Namespaced
foreign names remain qualified as `namespace.name`; the `multi_agent_v1` mapping
is unchanged. No historical tool is aliased to `exec_command` or executed.
Original normalized history remains the source for existing diagnostics and
guidance, while Guardian prompts and the system-collapse contract are unchanged.

Results retain their call IDs and order. String results remain strings. Arrays
of `input_text` parts use a JSON text envelope to retain every part and boundary.
Non-text historical tool outputs fail explicitly rather than losing images or
files. This limitation does not change image support in user messages.

## Opaque compaction

The gateway rejects an input containing `compaction` before sending it to Devin,
even when adjacent visible messages or an unverified summary field are present.
Compaction contains provider-specific encrypted context. Neither an item ID nor
bookkeeping metadata is a substitute for the missing context. The gateway never
decodes the payload, treats it as a summary, or silently omits it.

For such a conversation, continue with the original provider and request a
visible text handoff covering the objective, constraints, decisions, completed
work and evidence, relevant paths/revisions, outstanding work and next steps.
Review the handoff for accuracy and sensitive data, then paste it into a new
gateway conversation. This is an explicit text handoff, not a lossless transfer
of encrypted state. If the original provider is unavailable, create a reviewed
handoff from the original visible transcript and repository state, marking gaps
as unknown. Do not edit or remove items from the original conversation to bypass
the rejection.

### Explicit lossy skip (opt-in)

Setting `DEVIN_CROSS_PROVIDER_SKIP_COMPACTION=1` on the gateway process changes
only this case. Each opaque `compaction` item is dropped, and one notice replaces
the first one so the model knows earlier context was unavailable. The gateway
does not decode or summarize the payload. Every other item keeps its position,
and any other unsupported item still fails. Requests are not changed in the
original Codex conversation. Set the variable in the gateway environment and
recreate the container to change it. This loses the information held only in the
encrypted payload and is off by default.
## Devin transport reference (2026-10-26)

Authentication (`GetUserJwt`) and chat (`GetChatMessage`) now use the released
CLI metadata tuple from the installed OMP 18.12.6 adapter: `ideName=devin-cli`,
`ideType=chisel`, IDE/extension version `3000.11.3`, `extensionName=chisel`,
locale `en`, and the host OS. The protobuf encoder includes `ide_type` at field
28 and `os` at field 5, verified against OMP's generated `MetadataSchema`.
Reference source: `@oh-my-pi/pi-catalog/src/wire/devin.ts` and
`src/discovery/devin-proto.ts`, used by `@oh-my-pi/pi-ai/src/providers/devin.ts`.
Model discovery retains its existing separate metadata and behavior.

OMP sends MCP capabilities as regular function definitions and executes calls
in its client. The gateway retains the same client-execution boundary: Codex
executes MCP calls with its own approval/security controls and credentials.
Existing reversible tool names, schemas, strict flags, call/result identities,
history, system collapse and undeclared-tool rejection are unchanged. No MCP
server configuration or credentials are added to the gateway.

Offline tests verify auth/chat metadata on the wire and MCP tool-call transport;
they do not establish that this resolves Devin's upstream `permission_denied`
(`MCP configuration issue`). One live Codex Memory call and result continuation
remain necessary after a separately authorized deployment. No live inference
was used to select or validate this change.

Opt-in safe Responses diagnostics report the actual forwarded `tool_count`;
the tool-name/mapping/fingerprint catalogs still contain at most 64 entries,
with `tool_catalog_truncated` indicating that limit. Each fingerprint includes
`schema_structure`: counts of fixed schema keywords, schema nodes, maximum
depth, type arrays and closed objects. Only schema-valued positions are walked;
property names, reference targets, descriptions, defaults, examples and enum or
const values are never emitted. Analysis stops at 128 KiB, 1024 schema nodes or
depth 32, reporting `truncated`; missing or invalid JSON has an explicit status.
These diagnostics do not alter schemas or tool execution.

## Local evidence and limits (2026-10-25)

The failing fork copies were deleted before this investigation, so their exact
complete inventories and index positions cannot be verified. Surviving local
histories contain `message`, `reasoning`, `additional_tools`, `function_call`,
`function_call_output`, `custom_tool_call`, `custom_tool_call_output`, and
`compaction`. No other response-item types were observed in the inspected
histories. Foreign function names, not just custom calls, needed historical
conversion; this is separate from adding new executable tools.

The inspected custom outputs contain `input_text` arrays. Inspected compaction
items contain only `type`, `id`, `encrypted_content` and internal metadata whose
only key is `turn_id`; no visible summary or content field is present. Adjacent
visible turns cannot establish that encrypted context is redundant.

The installed native runtime is 0.164.0-alpha.11.1. Read-only binary marker
inspection confirmed the custom-call and compaction variants, and the installed
OpenAI SDK types confirm raw string custom input, string/content-array results
and encrypted compaction. Native layout inspection through REA was unavailable
for this Windows target, so no decompilation claim is made. No runtime instruction
text, conversation text, encrypted payload, or secrets were copied into tests or
this document. All regression fixtures are synthetic.

A surviving custom-call history passed the full local converter-to-Devin-prompts
path without changing its source. A surviving opaque-compaction history was
rejected with the handoff explanation. These are offline conversion checks, not
live inference or confirmation of the deleted copies. A custom-call-only fork
with the observed visible item shapes should now convert; an opaque-compaction
fork cannot transfer losslessly to SWE-2. Unobserved item variants still fail
explicitly and require separate evidence before conversion support is added.
