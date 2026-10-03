# Model validation status

The picker records status for exact concrete variants, independently of enabled models, role assignments and the selection revision. Nothing is inferred from old logs or bundled compatibility profiles. Existing variants start Untested until a new completed tool validation or deliberate manual mark.

## Automatic evidence

Completed normalized call IDs are exact opaque internal identities, not display/log identifiers. A separate validator permits provider punctuation and IDs longer than 128 characters, with no trimming, case changes or prefix requirement. The operational limit is 4,096 UTF-8 bytes: at most 1,024 pending calls bound ID payload near 4 MiB, plus runtime overhead. Empty/blank, invalid Unicode, C0/C1 control characters and Unicode line separators reject. Registered credentials and secret-like markers remain separate privacy rejections. IDs above this budget fail closed for evidence without changing bridge emission.

Raw call IDs never enter safe JSONL. `tool_calls` now summarizes names only; fixed identifier stage/reason records, counts and correlation outcomes remain. Internal evidence retains the exact identity, and promotion still requires a previously emitted matching call, credential scope, concrete model, effort and completed successful continuation. Arbitrary user messages cannot establish evidence. The shared display/log identifier regex remains unchanged.

The gateway correlates a completed, validated emitted tool call with a later function_call_output in memory. Correlation requires the same hashed credential scope, concrete model, requested effort and call ID. The continuation must have upstream HTTP 200, upstream completion, response completion and no failure classification. Replayed assistant history cannot establish an issued call. Pending IDs expire after one hour and are limited to 1,024; restart discards pending evidence, not saved status.

Responses has no universal local tool success flag. Only an explicit zero exit code in a structured result or the native Codex terminal command envelope, or a structured success status without an error, qualifies. Opaque output, nonzero exit, running sessions and text-only responses remain Untested. No tool arguments or output are retained. This proves reported client-side success, not independent execution by the gateway; the gateway still executes no commands.

Safe JSONL retains existing routing fields and adds had_tool_call and had_function_call_output booleans. The first describes validated emitted calls, not history. The second describes current request output items. All existing error classifications remain diagnostic-only. In-process status collection works without enabling JSONL and suppresses raw Responses tracing.

Routing identifiers come from completed gateway model resolution. Emitted calls come from the same finished, validated accumulator used by the Responses bridge; returned calls come from the Responses converter's normalized tool messages. These structured paths reject credentials and malformed identifiers, but do not discard a valid ID merely because Desktop history or a tool schema mentions it. Arbitrary trace/error fields retain the stricter sensitive-text substring check. Matching uses the exact credential scope, call ID, resolved variant and requested effort across separate requests; the two evidence booleans need not both be true on one request.

### Recognition-stage diagnostics

Safe JSONL now reports `tool_choice_mode` (including omitted), `requested_specific_tool` only from validated declared tool identity, `upstream_tool_choice_mode`, client/upstream parallel booleans, and fixed `normalized_input_type_counts`. No input text is retained.

Follow the counters in order: `upstream_toolcall_event_count` → `normalized_tool_call_object_count` → `bridge_completed_tool_call_count` → `responses_tool_call_emitted_count` and `tool_evidence_emitted_count`. Decoded object counts include follow-up deltas; completed/emitted counts refer to consolidated calls. Responses emission describes an item handed to the existing output path, not proof that the client executed it.

`identifier_checks` is bounded to 64 records with fixed stage, field, accepted/rejected state, reason and `sensitive_text_overlap` boolean. Reasons are missing, invalid_format, secret_like or redaction_collision. Missing can be an expected unkeyed follow-up delta. No rejected value is logged. Sensitive overlap is observable even for accepted structured IDs, but it does not mean a credential collision. `bridge_outcomes` counts existing accumulator/argument failures and same-ID deltas without changing their handling.

`function_call_output_input_count` and `tool_evidence_returned_count` distinguish normalized input from accepted correlation evidence. `correlation_results` records existing outcomes: request_ineligible, expired_pending, no_issued_call, scope_mismatch, model_mismatch, effort_mismatch, tool_result_not_successful, matched_success or issued_call_recorded. matched_success means the existing tuple and completion checks passed and persistence was scheduled; it is not an extra success criterion. These counters are serialized after the in-process observer runs. No credential scope/hash or tool result is exported.

The existing bridge and diagnostic identifier validators have different limits. A synthetically long nonempty call ID can be emitted to Responses while rejected for evidence as invalid_format. The new counters identify that boundary; this is not proof that live SWE IDs have that shape. Production tool forcing, routing and automatic promotion rules are unchanged.

## Sequential tool-loop acceptance boundaries

The Responses bridge is structurally iterative across requests and regression-tested
through two and three sequential tool cycles in both JSON and SSE modes. This is
not a claim of unlimited tested conversation length. One distinct tool call per
model response remains intentional; upstream parallel tool calls remain disabled.

The client supplies the entire ordered history on every continuation. There is no
server-side `previous_response_id` history store. The final request after two
cycles contains user, assistant call A, result A, assistant call B, result B.
Call IDs retain exact spelling; arguments preserve JSON semantics rather than
whitespace/key formatting. Every tool-call response is itself `completed`; it is
not the conversation's final text response.

Issued-call evidence is memory-only and effectively keyed by credential scope,
exact opaque call ID, concrete model and effort. There is **no independent Codex
thread ID**. Distinct provider IDs isolate ordinary conversations, but two threads
sharing the complete tuple are not formally isolated by a separate thread boundary.
Do not invent a thread identifier from prompts or request-local IDs.

A completed successful round trip may establish Tested. A different completed
call may refresh status/revision. Replaying a consumed output cannot promote it
again. Failed requests do not consume pending evidence or clear prior success;
pending calls expire after one hour. Existing model/effort/credential mismatch
checks remain required.

Returned evidence considers the **first 16 valid returned calls**, in input order,
per request (not the last 16). Full normalized history still goes to Devin; the
cap affects only automatic Tested evidence. An output beyond this cap cannot be
claimed as covered by automatic evidence. This does not limit the planned two-
and three-cycle acceptance test.

Tool frames are consolidated until upstream completion. For the supported
`text -> toolcall -> text` fixture, Responses emits combined text followed by the
completed function call, not literal tool/text interleaving. Reasoning before
text/tool is covered by existing SSE index tests. Re-entrant reasoning **after**
text remains outside validated ordering: the current single message/reasoning
state can reuse item identities/indexes if reasoning starts again. Do not claim
that arbitrary alternation is supported or change it without a separate review.

Offline HTTP-abort coverage waits for the first real downstream text delta,
aborts the client, and checks that the mock upstream HTTP request is aborted.
This validates server signal propagation, not every Desktop cancellation UI path.

### Manual sequential acceptance (not run by offline tests)

Use the existing guarded workflow and a new thread with a Tested model/effort.
Ask for exactly two dependent local commands: first hostname, then (only after
its result) current date; finally report both. Do not spawn workers or run tools
in parallel. Verify three completed Responses requests: call A, result A plus
distinct call B, then results A/B plus final text. Safe diagnostics must show
the expected emitted/returned counts and successful correlation without raw
IDs, arguments, results, credentials or prompt text. Only after this passes,
repeat with a third sequential read-only command for the PowerShell version.

## Manual marks and persistence

Use Mark tested / Mark untested on the exact variant row (for example SWE-2 Medium, High and Max). Marks save immediately; Save/Cancel applies only to selection drafts. The buttons never change enabled state or roles. The compact status badge tooltip reports manual/automatic provenance and the last automatic success timestamp when available.

Manual overrides are authoritative, including Mark untested. Future automatic evidence is retained separately but does not override a manual decision. A later transient inference failure never clears saved Tested status. Refresh/reopen the picker to obtain external updates or resolve a status ETag conflict.

Private settings file: model-test-status.json in the existing settings directory/volume, separate from OAuth and model-selection.json. Atomic writes use a 0600 temporary file and rename; the directory is 0700 on Linux. Corrupt state fails closed and is not silently reseeded. Its own revision/ETag handles competing status writers; selection revision is unaffected.

```json
{
  "schemaVersion": 1,
  "revision": 2,
  "variants": {
    "swe-2-high": {
      "automatic": {
        "source": "automatic",
        "lastSuccessAt": "2026-10-02T12:00:00.000Z",
        "logicalModel": "swe-2",
        "effort": "high"
      },
      "manual": {
        "source": "manual",
        "status": "tested",
        "updatedAt": "2026-10-02T12:01:00.000Z"
      }
    }
  }
}
```

The example is synthetic. No script, instruction text or credential belongs in this file.

Management-only API:

- GET /admin/api/model-test-status returns the private status data and ETag.
- PUT /admin/api/model-test-status accepts exactly modelId and status, with application/json, x-devin-management: 1 and If-Match. A stale ETag returns 412.
- GET /admin/api/models merges effective status into the variant rows and supplies testStatusETag.

Existing Host/Origin/CSRF guards and the loopback-published management listener apply. These routes are never exposed on the inference listener. Codex selection export remains based on enabled + available + structurally compatible, never Tested gating.
