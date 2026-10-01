# Clean-fork Devin Desktop worker test

This guarded, one-run workflow uses the gateway source in `<repository>`. It never starts Codex Desktop or submits a model request; you perform both manually.

## Run the manual test

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

Remote mode requires the gateway's `/health` to report `status = ok` and `collapse_system_enabled = true`. If it also reports `fallback_token = not_set`, the wrapper starts the existing interactive `devin-login` Compose service over SSH, recreates only the gateway, and waits for `fallback_token = set`. The credential stays in the devhub Docker volume and never passes through Windows or Codex Desktop. If health already reports `set`, login and restart are skipped. Remote authentication errors fail closed without falling back to localhost.

The gateway launcher resolves the repository root from its own location, checks a reviewed fingerprint of every file under `src/**`, `package.json`, the available Bun lockfile(s), `DevinOAuthBridge.ts`, and runtime configuration (`tsconfig.json` and `bunfig.toml` when present), then starts the clean-fork server on loopback. Bun's automatic `.env` loading is disabled. The PKCE OAuth helper exchanges the callback code, holds the resulting token only in memory, and passes it directly to `startServer`. It does not invoke the token-persisting login CLI or write credentials. It also avoids an eager `GetUserJwt` validation call because that path may log raw upstream auth error details outside a Responses diagnostic context; token validity is first exercised by the one manual Responses request. Debug, raw body/header logging, and error tracing stay disabled.

The wrapper explicitly enables system collapse and safe allowlisted Responses diagnostics at a fresh GUID-named file under the ignored repository `logs` directory. It verifies `/health` reports `collapse_system_enabled: true`, `/v1/models` contains both `glm-5-3-flash-low` and `swe-2-medium`, and the listener is exactly `127.0.0.1:38643` before changing the Codex profile.

The guarded switch takes a fresh byte-for-byte backup and SHA-256 of the current Codex config and worker state. It uses the already validated static catalog at `<CODEX_HOME>\model-catalogs\devin-0.158.json`, configures GLM as the parent, and installs `swe_worker` with `model = "swe-2-medium"` and `model_reasoning_effort = "medium"`. Provider inheritance, sandbox, approval, and other security settings are preserved.

When the wrapper prints `WORKER TEST READY`, manually launch Codex Desktop, select GLM-5.3 Flash Low, create a new thread, and send exactly once:

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
