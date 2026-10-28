# Experimental SWE-2 completion-marker protocol

`DEVIN_SWE_AUTONOMOUS_CONTINUATION=1` opts Responses requests into this protocol.
It is disabled by default and applies only after routing to canonical SWE-2
variants (`swe-2-medium`, `swe-2-high`, `swe-2-max`). Other models and endpoints
retain their existing behavior.

Every request appends gateway-owned completion guidance after the existing
supplements, without changing the native instruction anchor or history. The
existing collapse transformation includes this guidance when enabled. Subsequent
client continuation requests receive the same guidance.

For text-only STOP_PATTERN responses without `[PROCESS_DONE]` as the exact final
non-whitespace line, the completed response object includes `end_turn: false`.
A final marker sets `end_turn: true`. The marker remains visible in both streamed
text and final output. Tool calls, errors, cancellation and MAX_TOKENS truncation
retain existing handling. Other unmarked stop reasons remain unchanged.

The gateway does not send hidden user messages or make continuation requests.
Codex owns continuation and user Stop. There is deliberately no continuation
count, text heuristic or new timeout. Monitor the first experiment: a model that
never emits the marker may continue until the operator stops it or an existing
provider error/timeout occurs. Marker compliance is not proof of task completion.
Offline cancellation coverage verifies client disconnect aborts upstream without
issuing another gateway request; the real Desktop Stop UI remains a manual
acceptance check. Previous installed-backend mock testing established support
for `response.end_turn: false`; that runtime experiment is not repeated here.

## Deployment, only after explicit approval

Do not deploy while Codex Desktop or its backend is running. Deliver the reviewed
patch/commit to the gateway host checkout first. Record the current commit and local
configuration for rollback. Preserve operator files and both named volumes.

In the existing gateway directory, set the following in the operator-owned `.env`
(never place credentials in this setting):

```ini
DEVIN_SWE_AUTONOMOUS_CONTINUATION=1
```

Then run:

```sh
docker compose config --quiet
docker compose build devin-gateway
docker compose up -d --no-deps --force-recreate devin-gateway
docker compose ps devin-gateway
curl --fail --silent http://127.0.0.1:38643/health
```

If inference is published only on a private host interface, use that existing
private bind address rather than loopback for the health check. Require status
`ok`, fallback token `set`, and collapse enabled. Health does not attest to the
completion flag; verify its non-secret value with:

```sh
docker compose exec -T devin-gateway sh -c 'test "$DEVIN_SWE_AUTONOMOUS_CONTINUATION" = 1'
```

For behavior rollback, set the flag to `0` and recreate only the gateway after
Desktop/backend are stopped. Never remove auth/settings volumes. No runner
changes are required or included.
