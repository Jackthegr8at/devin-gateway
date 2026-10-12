# SWE-2 approval reviewer routing

When the validated selection includes the logical `swe-2` model with the enabled
`medium -> swe-2-medium` route, the generated Codex catalog sets:

```json
{"slug":"swe-2","auto_review_model_override":"swe-2-medium"}
```

It also includes a hidden `swe-2-medium` preset with default effort `medium` and
supported efforts exactly `[medium]`. This prevents Codex's reviewer selection
from inheriting a parent High/Max effort when the override target is absent from
the catalog. The logical agent entry, worker role and saved selection are unchanged.
No reviewer override is added when Medium is not enabled. Other model entries
are not redirected.

The source for installed Codex `rust-v0.162.0-alpha.17.2` identifies synchronous
reviewer requests using `x-codex-guardian: reviewer` on Codex-backend routes.
Custom providers receive `x-openai-subagent: guardian`, also projected as
`client_metadata["x-openai-subagent"] = "guardian"` in the Responses body.
The gateway accepts these exact structured discriminators, not model names,
prompt wording or assessment output. Other subagent labels are ordinary agents.
These requests retain the supplied native review instructions and omit gateway
agent supplements, including `[PROCESS_DONE]`. The autonomous feature cannot set
`end_turn:false` for them. Collapse, upstream errors, cancellation, truncation and
response text remain governed by the existing Responses paths.

This header is classification, not authentication or permission authority.
The gateway does not interpret assessments or approve commands. Codex retains
its output-contract validation, risk decisions and sandbox/approval enforcement.
Live assessment quality has not been validated by offline catalog/transport tests.

This change does not activate a provider, edit active Codex files or update the
separate runner. That runner must adopt the catalog change in a separately
approved step before its existing activation workflow can use this override.
