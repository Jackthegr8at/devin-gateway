# Tool-catalog reliability: offline characterization

This audit does not broaden tool support or certify live provider catalog limits.
The Responses path forwards exactly six reviewed identities: `exec_command` and
`multi_agent_v1`'s spawn_agent, send_input, wait_agent, resume_agent, close_agent.
All other names/namespaces are intentionally filtered. A raw 146-function input
therefore still forwards six functions. Generic protobuf tests with larger tool
arrays exercise serialization only, not arbitrary Codex tool support.

## Boundaries and failure behavior

| Area | Current boundary |
| --- | --- |
| Responses tools | Array required; one reviewed flat identity and five reviewed namespace leaves |
| Forwarded count | At most six distinct identities; duplicate reviewed identities return HTTP 400 |
| Namespaces | Only exact case-sensitive multi_agent_v1; no recursive namespace traversal |
| Names | Exact reviewed strings; unsupported case/long/flattened lookalikes are ignored |
| Schema | Non-array object required; JSON Schema semantics are not independently validated |
| Description | String required for reviewed tools; only exec_command description is replaced |
| strict | Boolean or omitted; omitted becomes false |
| Schema/description bytes | No explicit gateway byte cap or truncation for forwarded tools |
| Schema nesting | No application depth cap; JSON parsing/stringification engine limits apply; depth eight tested |
| Request body | Gateway does not set maxRequestBodySize; installed Bun type documentation specifies default 128 MiB; boundary not stress-tested |
| Outgoing Connect frame | Compressed byte length encoded as uint32; no smaller explicit send budget |
| Incoming Connect frame | 16 MiB compressed frame payload and decompression-output guard; response-side, not catalog budget |
| Returned tool calls | One distinct call per model response; upstream parallel calls disabled |
| Diagnostic identities | ASCII allowlisted identifier, at most 128 characters |
| Catalog diagnostic detail | First 64 source entries considered; invalid identifiers omitted; tool_count is retained mapping count, not an uncapped total |
| Other diagnostic bounds | Tool-call names/evidence 16; identifier checks 64; existing correlation-ID bound unchanged |

No authoritative Devin tool-count, tool-name, request-byte or schema-depth maximum
was established offline. Do not treat fixture sizes as production limits. A generic
large-catalog exposure feature would need separate eligibility, failure, collision
and diagnostic-total review before these six-identity assumptions can be relaxed.

Unsupported declarations are filtered before schema validation. Invalid object
shape for a reviewed tool fails; an object containing a semantically invalid JSON
Schema type currently passes to Devin. This is a documented validation boundary,
not a newly introduced schema policy. Specific choice of a filtered tool fails
with HTTP 400 and never reaches chat.

## Identity, order and schema integrity

Mapping is keyed by exact Devin name, never array position. Reviewed namespace
names flatten to multi_agent_v1__leaf and restore through the identities Map.
Unqualified flattened lookalikes and other namespaces cannot overwrite this Map:
they are filtered. Duplicate accepted keys fail rather than overwrite. General
namespace_a/namespace_b leaves are not supported by the Responses bridge; generic
protobuf strings preserve them without coalescing names or case.

Input order is retained for forwarded tools. Reordered catalogs still map the
same name to the same schema/description/strict flag. Selection quality from an
upstream model may depend on order; offline translation tests cannot establish it.
Schema JSON is serialized once per accepted declaration, then encoded without
truncation. Tests assert semantic equality, exact serialized hashes and input
immutability. Arrays, enums, nullable/optional fields, nested objects and distinct
per-tool markers exercise isolation. Preserved descriptions of 128 KiB and schema
padding of 256 KiB survive protobuf round trips.

## Approximate local measurements (not benchmarks)

Synthetic incoming fixtures contain the requested unrelated flat count plus 18
leaf declarations across supported/unsupported namespaces. Each schema has about
1 KiB padding and eight nested object levels.

| Unrelated flat count | Raw JSON bytes | Forwarded protobuf bytes | Translation ms |
| --- | ---: | ---: | ---: |
| 16 | 70,783 | 12,385 | 0.20 |
| 32 | 104,311 | 12,385 | 0.06 |
| 64 | 171,367 | 12,385 | 0.06 |
| 128 | 305,535 | 12,385 | 0.08 |

Generic protobuf-only arrays at 16/32/64/128 tools measured approximately
32,724/65,316/130,500/260,924 bytes, with schema serialization 0.09–0.35 ms and
encoding 2.0–6.8 ms. Bytes scale approximately linearly; no correctness dependence
on a small index or observed quadratic count growth. Encoder intermediates use
number arrays and copy each nested message: allocation overhead grows with bytes;
heap deltas were not treated as reliable measurements. There is no demonstrated
optimization need in these fixtures.

Synthetic diagnostic-only records at 6/16/32/64/128 tools measured approximately
3.3/7.1/13.2/25.4/25.4 kB. They already stop detailed collection at 64,
so no new truncation is proposed. Real Responses catalogs cannot currently reach
that diagnostic cap: six forwarded tools yield about 3.3 KB in the minimal fixture.
If support is broadened later, tool_count's capped meaning should be revisited
with an explicit total count, deterministic sample and aggregate hash.

## Coverage and next acceptance

Tests cover large mixed incoming catalogs, reordering, schema/strict isolation,
duplicate reviewed keys, malformed shape, filtered long/case/namespace aliases,
large descriptions, generic protobuf catalogs and diagnostic bounds/privacy.
Actual JSON/SSE integration uses 128 unrelated tools and all six eligible tools:
first/middle/last eligible return identities, auto/required/specific choice,
exact call IDs, unchanged full catalog on continuation, normalized tool evidence
and namespace restoration. Namespaced function results are synthetic; no native
agent is spawned. Specific choice remains auto→auto, required→any or exact declared
name; upstream parallel calls remain disabled. Existing sequential tests remain.

No raw schemas/descriptions, prompts, arguments, outputs, credentials or call IDs
are added to safe diagnostics. Test measurements print only sizes/times/counts.

Recommended next manual test, only after review: use an ordinary full Desktop
catalog in a new thread with a Tested model/effort, ask for one local hostname
command and its final result, and check safe diagnostics for the six-or-fewer
forwarded identities, fingerprint stability and one completed tool round trip.
Compare raw versus forwarded catalog counts using local-only capture if necessary;
do not claim that ignored plugins/MCP tools are accepted upstream. Larger forwarded
catalog live testing first requires a separately approved support design.
