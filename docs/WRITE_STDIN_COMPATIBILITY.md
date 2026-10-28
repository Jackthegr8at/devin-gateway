# write_stdin declaration compatibility

The Responses converter normalizes only the top-level, unnamespaced
`write_stdin` description sent to Devin:

> Send input to a running command session or read its output.

The original function identity, parameters (including their descriptions,
required fields and numeric types), strict flag, call IDs, inputs and results
are unchanged. Calls still return to Codex for execution under its own security
controls. Historical calls remain structured when currently declared. Duplicate
declarations are checked against their original descriptions, so normalization
cannot mask a conflict. Other namespaces' functions named `write_stdin` are not
changed. Strict validation of newly generated names remains enabled.

## Evidence (2026-10-26)

The installed Codex declaration has an 80-byte description and a 618-byte JSON
schema. The schema contains chars/string, max_output_tokens/number,
session_id/number and yield_time_ms/number, with only session_id required and
additionalProperties false; strict is false. The converter previously forwarded
the name, description and schema without changes. No original runtime prose,
private prompts, arguments, outputs or credentials are retained in this document.

Read-only OMP 18.12.6 inspection shows ordinary function name/description/schema
serialization. Its shell tool is named `bash` with its own interactive/session
implementation; no equivalent native `write_stdin` declaration was found in the
inspected tools source. OMP therefore does not establish that the Codex prose is
accepted by Devin, nor justify remapping or changing Codex's schema.

Controlled SWE-2/medium declaration tests retained six Memory tools and exactly
one write_stdin declaration. Only Memory recall was allowed to execute:

| Variant | Actual tools | Outcome | Request IDs |
| --- | ---: | --- | --- |
| Original declaration | 7 | permission_denied / MCP configuration issue | 6d5f2636 |
| Only description replaced | 7 | recall and continuation completed | 7bc0920f, c6d4dacf |
| Same description replacement repeated | 7 | recall and continuation completed | c5359a0a, 8c2173c3 |

Name, schema and strict flag were held constant. No name/schema experiments were
needed after description-only acceptance reproduced. This confirms that the
original description triggers the upstream rejection; the precise backend
policy rule or triggering substring is not exposed by the sanitized diagnostics.

A separate controlled Codex shell test retained Memory, exec_command and
write_stdin (8 declarations). A fixed read-only Node command printed a marker,
waited for stdin, printed a completion marker after receiving fixed input and
exited zero. The controller validated the exact command, session association,
stdin text and output limits before allowing each call to reach Codex. An initial
attempt stopped at the safety gate without completing stdin verification. After
adding support for structured/text exec output envelopes to the private test
driver, the bounded execution test succeeded:
610bca77 (exec_command), 6e042667 (write_stdin), 8f04a7ef (tool-result continuation).
Raw command outputs and private content were not saved.

These live tests applied the description change through an opt-in local proxy
and used the existing production gateway. The gateway service was not changed,
deployed or restarted. The committed converter change still requires a separately
guarded deployment; it never permanently filters out write_stdin.
