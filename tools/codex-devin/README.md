# Clean-fork Devin Desktop worker test

## Normal-use acceptance boundary

SWE-2 normal coding usage, sequential local-command loops, one-worker
spawn/wait/close, and two independent
sibling workers have passed real Desktop acceptance. Explicitly close every
created worker. Prefer a fresh worker for follow-up work: send-input delivery and
child completion are proven, but its full parent lifecycle is paused after an
unresolved Desktop renderer crash. Resume and nested agents are not live tested.
No gateway defect was demonstrated, and the crash investigation is closed.
These limitations do not change tool eligibility. See
[lifecycle evidence and orphan cleanup](MULTI_AGENT_LIFECYCLE.md).

Verify the guarded wrapper's config/worker restore hashes after each use. This
supported subset is ready for normal day-to-day use, not an unconditional
unattended-operation guarantee.

Persisted selection and Tested status survive gateway recreation in the settings
volume; Devin authentication remains in its separate auth volume. A health result
of `fallback_token=set` reports credential presence, not expiry or upstream
availability. Gateway restarts interrupt in-flight requests and clear pending
in-memory Tested correlation; they do not clear already-persisted Tested marks
or implicitly close Codex children. Retain both volumes and recovery records.

The guarded wrapper restores config/worker bytes only after real Desktop/backend
processes exit. After an interrupted wrapper or machine restart, resolve its
existing recovery record with the restore workflow before enabling another run;
never delete recovery evidence to bypass the guard. Successful restore removes
the managed temporary worker or restores its pre-test version, and restores the
original config so it no longer depends on the per-run catalog. Catalog bytes
remain in the recovery record for evidence; they are not active configuration.

### Sustained-use operational limits

- Selection and Tested writers use bounded, fail-closed directory locks. Abrupt
  process termination while holding a lock can leave it behind. Inspect ownership
  and confirm no writer remains before any manual recovery; never remove a live
  writer's lock. Offline tests cover refusal, not automated stale-lock recovery.
- Long histories remain subject to the selected upstream model's context limits;
  the gateway does not provide conversation compaction or durable request replay.
  Extended soak/load and restart-between-tool-turn scenarios are not certified by
  the existing short synthetic tests.
- Safe diagnostic JSONL is append-only when enabled. Arrange retention/rotation
  and monitor disk space for prolonged use; do not enable raw/debug tracing as a
  substitute. Settings/auth volume backups must remain private.

The model picker now persists exact-variant Tested/Untested status separately from enabled models and roles. See [model validation status](MODEL_TEST_STATUS.md); manual marks save immediately and never change the activation manifest.

This guarded, one-run workflow uses the gateway source in the current repository checkout. It never starts Codex Desktop or submits a model request; you perform both manually.

## Run the manual test

Run the examples from the repository root. The Codex home defaults to
`Join-Path $env:USERPROFILE '.codex'`; an explicitly set `CODEX_HOME` must be an
absolute existing directory, not a filesystem root. Profile/home reparse points
are rejected. The example remote address is documentation-only; replace it,
the SSH user, repository directory and identity file with your own settings.

After fully closing Codex Desktop, open a standalone PowerShell window and run:

```powershell
Set-Location .\tools\codex-devin # from the repository root
.\Run-CodexDevinWorkerTest.ps1
```

The wrapper verifies Desktop is closed and port `127.0.0.1:38643` is free. It will not stop an existing listener; close that gateway from its own terminal and retry if the port is occupied.

To use the already-running private devhub gateway instead, pass its URL and SSH connection details. The identity-file argument is optional when the SSH key is available through the agent or SSH config; provide it when using a non-default key filename:

```powershell
.\Run-CodexDevinWorkerTest.ps1 `
  -GatewayUrl 'http://192.0.2.10:38643' `
  -RemoteSshTarget 'gateway-user@192.0.2.10' `
  -RemoteGatewayDirectory '/srv/example/services/devin-gateway' `
  -RemoteSshIdentityFile (Join-Path $env:USERPROFILE '.ssh\gateway-key')
```

Remote mode requires the gateway's `/health` to report `status = ok` and `collapse_system_enabled = true`. If it also reports `fallback_token = not_set`, the wrapper starts the existing interactive `devin-login` Compose service over SSH, using `sudo -n` for Docker access, recreates only the gateway, and waits for `fallback_token = set`. The credential stays in the devhub Docker volume and never passes through Windows or Codex Desktop. If health already reports `set`, login and restart are skipped. Remote authentication errors fail closed without falling back to localhost.

The gateway launcher resolves the repository root from its own location, checks a reviewed fingerprint of every file under `src/**`, `package.json`, the available Bun lockfile(s), `DevinOAuthBridge.ts`, and runtime configuration (`tsconfig.json` and `bunfig.toml` when present), then starts the clean-fork server on loopback. Bun's automatic `.env` loading is disabled. The PKCE OAuth helper exchanges the callback code, holds the resulting token only in memory, and passes it directly to `startServer`. It does not invoke the token-persisting login CLI or write credentials. It also avoids an eager `GetUserJwt` validation call because that path may log raw upstream auth error details outside a Responses diagnostic context; token validity is first exercised by the one manual Responses request. Debug, raw body/header logging, and error tracing stay disabled.

The local wrapper explicitly enables system collapse and safe allowlisted Responses diagnostics at a fresh GUID-named file under the ignored repository `logs` directory. It verifies `/health` reports `collapse_system_enabled: true`, model discovery returns a nonempty valid list, and the listener is exactly `127.0.0.1:38643`. Remote mode skips local startup/port inspection. After health/auth validation, both modes fetch `/gateway/api/codex-selection` with a three-second timeout and no redirects before changing any Codex files.

The strict schema-v2 consumer validates enabled, available structural profiles, exact routes/efforts, authoritative metadata, role references and duplicate/conflicting entries. Live-tested history is informational, not an export or role gate. Missing or ambiguous metadata is excluded with a reason; an unavailable or ineligible role stops activation without substitution. Only enabled variants appear in a logical model's supported efforts. Unknown thinking indicators do not imply Off or an effort list.

Selection/discovery fetches have a 15-second deadline; health keeps its shorter three-second deadline. HTTP failures are reported separately from transport timeouts. A local gateway without selection enabled returns HTTP 404 and cannot access a remote gateway's persisted settings. Always select the intended `GatewayUrl`; there is no automatic local/remote fallback.

Structural eligibility does not guarantee successful inference. `DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM=1` enables provider-wide system collapse on Devin Responses requests. With the flag absent or zero, original placement is preserved. Collapse moves the exact composed system/developer text into the latest user-side representation without removal, rewriting, truncation or sanitization; prior history is unchanged. There are no per-model allowlists or temporary test flags.

For model/effort testing, use a new thread after switching models or a `response.failed`. Live SWE-2 High tests succeeded with text, local exec_command, tool continuation and final completion in a fresh thread after errors in an existing failed thread. This is an operator precaution, not a rule that every stream failure means thread contamination.

Safe diagnostics classify explicit third-party model-provider outages as `devin_upstream_model_provider_unavailable`, separate from policy denials and generic stream/Connect errors. Structured ErrorInfo reasons are used when present; the reported invalid_argument message requires a provider-specific availability match rather than code alone. Such outages never change the saved selection and do not certify or disqualify model compatibility.

The guarded switch takes fresh byte-for-byte config/worker backups and records their SHA-256 hashes. It generates deterministic UTF-8 catalog bytes under that run's recovery directory, records and checks their hash, selection revision/ETag, runtime version, and the verified instruction SHA-256 and UTF-8 length. It sets the parent's saved model **and effort** explicitly and installs `swe_worker` with its saved logical model **and effort**, without a provider override. The baseline is parent `glm-5-3-flash-low / low`, worker `swe-2 / medium`; gateway routing selects `swe-2-medium`. Provider inheritance, sandbox, approval, and other security settings remain unchanged.

The unique managed Desktop backend is validated against compatibility contract **1**, not a release-version allowlist. Version and executable SHA-256 remain recorded provenance. Before active mutation, bounded offline probes use disposable homes to recognize exactly one reviewed runtime-local instruction fingerprint and verify generated model IDs, efforts, V1, metadata and the complete shell_command/unified_exec alias; disabled must remain disabled. Unrecognized/ambiguous instruction content or incompatible catalogs fail closed. Probe instruction/catalog files are local-only and removed in finally blocks. Fresh byte-exact backups protect each run's immediate baseline. The gateway may not supply instructions, TOML, scripts or security settings. See [runtime provenance](templates/README.md). The reviewed launcher fingerprint covers contract metadata and processors; per-run catalog hashes remain enforced.

When the wrapper prints `WORKER TEST READY`, manually launch Codex Desktop, use the saved Default / parent model and thinking effort, create a new thread, and send exactly once:

```text
Spawn exactly one agent using agent_type = swe_worker.
Do not set a reasoning effort explicitly.
Have the worker inspect package.json and report the project/package name.
Wait for that worker to finish and return its result to me.
Do not spawn any additional agents.
```

Then fully close Desktop. The wrapper waits up to ten minutes for Desktop to start; after observing it, the wrapper waits indefinitely for it to close. It then restores the original config and worker state and independently checks their hashes. If Desktop never starts, it restores automatically. If automatic recovery cannot be verified, close Desktop and run:

```powershell
Set-Location .\tools\codex-devin # from the repository root
.\Restore-CodexOpenAI.ps1
```

The wrapper prints the safe diagnostic log path. After the config/worker restore is verified, stop the gateway by pressing Ctrl+C in its visible PowerShell window.
