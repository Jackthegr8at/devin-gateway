# Haiku Desktop catalog bisection

This is an opt-in diagnostic. The implementation is local and has not been deployed. Production was last verified at `f8168bc941e83df196eb37f20b1d94d9b092177d`; recheck before any deployment. A guarded wrapper exists but requires a separately reviewed commit and operator authorization. Close dependent Codex sessions for the initial deployment and eventual rollback. No restart is needed between diagnostic groups.

## Workflow after separately approved deployment

Use the normal Codex Desktop provider. No diagnostic provider or custom header is required. Run the controller with a fresh private state directory:

```powershell
$controller = '<repository-path>\scripts\Invoke-HaikuCatalogBisection.ps1'
$state = Join-Path $env:LOCALAPPDATA ('DevinGateway\haiku-bisect-' + [guid]::NewGuid().ToString('N'))
pwsh -NoProfile -File $controller -Action Start -StateDir $state
```

The next eligible Haiku 5.5 High request consumes the one-shot arm and forwards the first half of its actual incoming catalog. Start a fresh Desktop conversation and send `Reply with OK only.` once. Do not send any other Haiku High request until this one has consumed the arm: with no request header, the gateway cannot distinguish two simultaneous clients of that same model. Other models do not consume it. The arm expires after 180 seconds by default; an expired arm leaves normal requests unchanged.

After the request finishes, record its observed result:

```powershell
pwsh -NoProfile -File $controller -Result Pass -StateDir $state
# or:
pwsh -NoProfile -File $controller -Result Fail -StateDir $state
```

`-Result Auto` is also available. Results must agree with the correlated sanitized gateway record: a completed response is a pass, while `response.failed` with upstream `invalid_argument` is a fail. Unexpected errors, missing evidence, or attempted tool calls stop the process. Each accepted result arms the next half; use a fresh Desktop conversation with the same prompt and settings. The first request records the complete original catalog fingerprint and non-tool request fingerprint; later tests fail before inference if either changes. The request fingerprint normalizes verified per-conversation visualization UUIDs only in matching Codex permission and environment blocks, verified message IDs, and consistent session/turn/window/cache identifiers and timestamp metadata. Other context, settings, non-identity metadata, paths and array order remain strict. Fresh Desktop conversations may still differ, so stop and investigate genuine drift rather than interpreting it as an upstream result.

```powershell
pwsh -NoProfile -File $controller -Action Status -StateDir $state
pwsh -NoProfile -File $controller -Action Stop -StateDir $state
# Only after a correlated local context rejection or verified expired unclaimed arm:
pwsh -NoProfile -File $controller -Action Retry -StateDir $state
```

Retry preserves prior results and re-arms the same selection only for a correlated local context mismatch or the same verified expired, unclaimed arm. It refuses unknown consumed or in-flight arms. An existing state made with the earlier raw fingerprint cannot be migrated without its original request body; preserve that state as evidence and start a fresh bisection after deploying the fix.

Stop removes any unclaimed arm; normal requests continue without filtering. An already claimed request may still be in flight. Diagnostic calls reject all generated tools before emitting them to Desktop, and unselected tool names remain rejected by normal undeclared-tool validation. Overlapping eligible Haiku requests receive a conflict until the active diagnostic finishes. This lock is process-local and assumes the verified single gateway instance; do not run this workflow on multiple gateway replicas. Other models, Guardian requests and unarmed Haiku requests retain normal behavior.

The controller always tests the complement. If both halves pass, it stops inconclusive because an interaction or different context may be responsible. If both fail, it stops inconclusive because multiple causes or interactions are possible. A singleton is a candidate, not proof of a unique root cause. The default budget is 12 armed requests; checking both halves at each level can exhaust it before finding a singleton. The initial request does not independently reproduce the full-catalog failure; compare against separately established baseline evidence.

## Deployment and rollback

The two `deploy/operator/Deploy-Haiku*.ps1` files are historical, installation-specific wrappers. They require a private `Invoke-DevinDeploy.ps1` that is deliberately not included in this public snapshot. They cannot deploy or roll back from this checkout alone; do not treat their hardcoded baseline commits as a current deployment procedure. Use an independently reviewed deployment and rollback procedure for your installation, and verify its current baseline before any cutover.