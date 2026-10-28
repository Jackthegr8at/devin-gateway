# SWE autonomy and loop observation

The Responses path appends a gateway-owned autonomy supplement after exact wire
model resolution and native system/developer extraction, before the existing
collapse transformation. Only the reviewed SWE-2 concrete routes receive it.
Native instruction bytes and the local compatibility-contract anchor are not
changed. Completion, blocked work, user input, approval and destructive-action
confirmation remain valid stopping conditions. There is no auto-Continue or
tool forcing. Offline tests establish composition, not model obedience.

## Persistent safe diagnostics

Compose diagnostics remain opt-in. Set `DEVIN_RESPONSES_SAFE_DIAGNOSTICS=1` in the
private deployment `.env`, then recreate only the gateway. Its existing bind
mount persists `/app/logs/responses-safe-diagnostic.jsonl` in `./logs`, separately
from authentication/settings volumes. An ad-hoc Compose override omitted during
recreation does not persist this opt-in. Keep DEBUG and ERROR_TRACE disabled.
The reviewed sink records allowlisted metadata only; do not add raw prompts,
instructions, arguments/results, credentials or raw call/agent IDs.

## Conversation scope and future guard (not implemented)

The current gateway has no validated stable conversation identifier. Responses
metadata/previous_response_id are not consumed as conversation state. The Devin
cascade identifier and gateway response ID are newly generated per request;
credential/model/effort and call IDs must not substitute for thread identity.
Current retained diagnostics do not establish whether Desktop supplies a stable
metadata/header identity across continuations. Audit that before enforcement.

If a supported stable identity is established, hash it using a process-scoped
HMAC, namespace state by credential scope, model and effort, and bound retention.
Never persist raw identifiers. Candidate diagnostic fields are tool-identity,
canonical-argument and result HMAC fingerprints, consecutive repetition count,
scope availability, result success and intervening-progress classification.
Do not claim semantic progress from hashes alone. HMAC avoids exposing guessable
low-entropy commands/results through plain unsalted digests.

A future opt-in warning could follow three successful equivalent tool/argument/
result cycles without meaningful progress. It must not suppress execution,
fabricate results or retry invisibly. Changed results/arguments/tools, explicit
user retry, failure/recovery, meaningful intervening work and separate threads
must reset or distinguish state. Polling requires bounded, explicit treatment;
elapsed container age is not necessarily meaningful progress. No warning or
blocking behavior is active in this change.
