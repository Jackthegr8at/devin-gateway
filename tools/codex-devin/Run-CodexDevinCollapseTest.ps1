[CmdletBinding()]
param(
    [switch]$WorkerTest,
    [string]$GatewayUrl = 'http://127.0.0.1:38643',
    [string]$RemoteSshTarget,
    [string]$RemoteGatewayDirectory,
    [string]$RemoteSshIdentityFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')
Import-Module (Join-Path $PSScriptRoot 'CodexDevin.CollapseTest.Guards.psm1') -Force

$codexHome = Get-CodexDevinHome
$configPath = Join-Path $codexHome 'config.toml'
$workerPath = Join-Path $codexHome 'agents\swe_worker.toml'
$backupRoot = Join-Path $codexHome 'devin-desktop-switch-backups'
$gatewayTarget = Resolve-CodexDevinGatewayTarget -GatewayUrl $GatewayUrl
$isRemoteGateway = [bool]$gatewayTarget.IsRemote
$gatewayRoot = if ($isRemoteGateway) { $null } else { Resolve-CodexDevinGatewayRoot -ToolDirectory $PSScriptRoot }
$gatewayLauncher = Join-Path $PSScriptRoot 'Start-DevinGateway.ps1'
$enableScript = Join-Path $PSScriptRoot 'Enable-CodexDevin.ps1'
$restoreScript = Join-Path $PSScriptRoot 'Restore-CodexOpenAI.ps1'
$oauthHelperPath = Join-Path $PSScriptRoot 'DevinOAuthBridge.ts'
$bunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$diagnosticPath = if ($isRemoteGateway) { $null } else { Join-Path (Join-Path $gatewayRoot 'logs') ('responses-safe-diagnostic-' + [guid]::NewGuid().ToString('N') + '.jsonl') }
$testName = if ($WorkerTest) { 'Worker test' } else { 'Collapse test' }
$startupTimeout = [TimeSpan]::FromMinutes(10)
$gatewayReadyTimeout = [TimeSpan]::FromMinutes(30)
$gatewayShell = $null
$switchAttempted = $false
$newRunDirectory = $null
$preTestConfigSha256 = $null
$preTestWorkerSha256 = $null
$preTestWorkerExists = $false
$desktopWasObserved = $false
$restoreAttempted = $false
$restoreVerified = $false
$restoreFailure = $null
$failureMessage = $null
$gatewayStartupStatusPath = $null

function Get-CodexDevinCollapseNetstatLines {
    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
        throw 'netstat.exe is unavailable; listener inspection cannot continue safely.'
    }

    $native = [Diagnostics.Process]::new()
    $native.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $native.StartInfo.FileName = $netstatPath
    $native.StartInfo.Arguments = '-ano -p tcp'
    $native.StartInfo.UseShellExecute = $false
    $native.StartInfo.CreateNoWindow = $true
    $native.StartInfo.RedirectStandardOutput = $true
    $native.StartInfo.RedirectStandardError = $true
    try {
        if (-not $native.Start()) { throw 'Could not start bounded netstat inspection.' }
        $stdout = $native.StandardOutput.ReadToEndAsync()
        $stderr = $native.StandardError.ReadToEndAsync()
        if (-not $native.WaitForExit(5000)) {
            try { $native.Kill() } catch { }
            throw 'netstat listener inspection exceeded five seconds; no listener was stopped.'
        }
        $native.WaitForExit()
        if ($native.ExitCode -ne 0) { throw 'netstat listener inspection failed; no listener was stopped.' }
        return @($stdout.GetAwaiter().GetResult() -split "`r?`n")
    } finally {
        $native.Dispose()
    }
}

function Get-CodexDevinCollapseListeners {
    $lines = Get-CodexDevinCollapseNetstatLines
    return @(Get-CodexDevinCollapsePortListeners -NetstatLines $lines -Port 38643)
}

function Get-CodexDevinCollapseJson([string]$Uri) {
    try {
        return Invoke-RestMethod -Uri $Uri -TimeoutSec 3 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Invoke-CodexDevinRemoteSshCommand {
    param(
        [Parameter(Mandatory)][string]$SshTarget,
        [Parameter(Mandatory)][string]$RemoteGatewayDirectory,
        [string]$IdentityFile,
        [Parameter(Mandatory)][ValidateSet('Login', 'Restart')][string]$Action
    )

    if (-not (Test-CodexDevinSshTarget -SshTarget $SshTarget)) {
        throw 'RemoteSshTarget must be a safe SSH host or user@host value.'
    }
    $remoteCommand = New-CodexDevinRemoteComposeCommand -Action $Action -RemoteGatewayDirectory $RemoteGatewayDirectory
    $sshArguments = @(Get-CodexDevinRemoteSshOptions -Action $Action -IdentityFile $IdentityFile)
    $sshArguments += @($SshTarget, $remoteCommand)

    $ssh = Get-Command 'ssh.exe' -ErrorAction Stop
    if ($Action -ceq 'Login') {
        Write-Host "Starting interactive Devin login on devhub over SSH ($SshTarget). The OAuth URL and prompt will appear below."
        & $ssh.Source @sshArguments 2>&1 | Out-Host
    } else {
        Write-Host "Recreating only the devin-gateway Compose service on devhub over SSH ($SshTarget)."
        & $ssh.Source @sshArguments 2>&1 | Out-Host
    }
    return ($LASTEXITCODE -eq 0)
}

function Get-CodexDevinCollapseModelIds($Response) {
    if ($null -eq $Response) { return @() }
    $dataProperty = $Response.PSObject.Properties['data']
    if ($null -eq $dataProperty) { return @() }
    return @($dataProperty.Value | ForEach-Object {
        $idProperty = $_.PSObject.Properties['id']
        if ($null -ne $idProperty) { [string]$idProperty.Value }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-CodexDevinCollapseDesktopProcesses {
    $allProcesses = @(Get-Process -ErrorAction Stop)
    return @(Get-CodexDevinBlockingProcesses -Processes $allProcesses)
}

function Get-CodexDevinCollapseRecoveryDirectories {
    if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) { return @() }
    $directories = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction Stop)
    foreach ($directory in $directories) {
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "A recovery directory is a reparse point and needs manual review: $($directory.FullName)"
        }
    }
    return @($directories | ForEach-Object { [IO.Path]::GetFullPath($_.FullName) })
}

function Get-CodexDevinCollapseRecoveryRecords {
    $records = @()
    foreach ($directory in @(Get-CodexDevinCollapseRecoveryDirectories)) {
        $statePath = Join-Path $directory 'state.json'
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            throw "A recovery directory has no state manifest and needs manual review: $directory"
        }
        try {
            $state = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "A recovery state manifest is unreadable and needs manual review: $statePath"
        }
        $records += [pscustomobject]@{ Directory = $directory; StatePath = $statePath; State = $state }
    }
    return $records
}

function Assert-CodexDevinCollapseNoUnresolvedRecovery {
    foreach ($record in @(Get-CodexDevinCollapseRecoveryRecords)) {
        if ($record.State.status -notin @('Restored', 'ResolvedBeforeSwitch')) {
            throw "An unresolved recovery run already exists: $($record.Directory). Restore it manually before starting this test."
        }
    }
}

function Get-CodexDevinCollapseNewRun([hashtable]$ExistingDirectories) {
    $newDirectories = @(
        Get-CodexDevinCollapseRecoveryDirectories | Where-Object { -not $ExistingDirectories.ContainsKey($_) }
    )
    if ($newDirectories.Count -gt 1) {
        throw 'More than one recovery directory appeared during enable; automatic restore is disabled for safety.'
    }
    if ($newDirectories.Count -eq 0) { return $null }
    return $newDirectories[0]
}

function Get-CodexDevinCollapseRunState([string]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Directory)) { return $null }
    $statePath = Join-Path $Directory 'state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Wait-CodexDevinCollapseGatewayReady {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$LauncherProcess,
        [Parameter(Mandatory)][string]$StartupStatusPath,
        [Parameter(Mandatory)][object]$Target
    )

    $deadline = [DateTime]::UtcNow.Add($gatewayReadyTimeout)
    $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
    Write-Host 'Waiting up to 30 minutes for Devin sign-in and gateway readiness. Complete sign-in in the separate gateway window and leave it open.'
    while ([DateTime]::UtcNow -lt $deadline) {
        $LauncherProcess.Refresh()
        if ($LauncherProcess.HasExited) {
            $startupFailure = Get-CodexDevinGatewayStartupFailureMessage -StatusPath $StartupStatusPath
            if ($startupFailure) { throw $startupFailure }
            throw 'The visible gateway/OAuth PowerShell window exited before the gateway became ready. Codex config was not switched.'
        }

        $health = Get-CodexDevinCollapseJson -Uri $Target.HealthUri
        $models = Get-CodexDevinCollapseJson -Uri $Target.ModelsUri
        $modelIds = @(Get-CodexDevinCollapseModelIds -Response $models)
        if ($null -ne $health -and (Test-CodexDevinCollapseGatewayReady -Health $health -ModelIds $modelIds)) {
            $listeners = @(Get-CodexDevinCollapseListeners)
            if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1') {
                throw 'The gateway is healthy but its listener is not exactly 127.0.0.1:38643; Codex config was not switched.'
            }
            return
        }

        if ([DateTime]::UtcNow -ge $nextProgress) {
            Write-Host 'Still waiting for Devin sign-in, gateway health, collapse flag, and required model IDs...'
            $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
        }
        Start-Sleep -Seconds 2
    }
    throw 'Gateway readiness was not verified within thirty minutes. Codex config was not switched; stop the visible gateway window with Ctrl+C before retrying.'
}

function Write-CodexDevinCollapseRestoreHashes {
    $restoredConfigSha256 = 'missing'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try { $restoredConfigSha256 = Get-CodexDevinSha256 -Path $configPath } catch { $restoredConfigSha256 = 'unreadable' }
    }
    $configMatches = $preTestConfigSha256 -and $restoredConfigSha256 -ceq $preTestConfigSha256
    Write-Host "PRE_TEST_CONFIG_SHA256=$(if ($preTestConfigSha256) { $preTestConfigSha256 } else { 'not_captured' })"
    Write-Host "RESTORED_CONFIG_SHA256=$restoredConfigSha256"
    Write-Host ('RESTORE_HASH_MATCH=' + ([bool]$configMatches).ToString().ToLowerInvariant())

    if ($preTestWorkerExists) {
        $restoredWorkerSha256 = 'missing'
        if (Test-Path -LiteralPath $workerPath -PathType Leaf) {
            try { $restoredWorkerSha256 = Get-CodexDevinSha256 -Path $workerPath } catch { $restoredWorkerSha256 = 'unreadable' }
        }
        $workerMatches = $preTestWorkerSha256 -and $restoredWorkerSha256 -ceq $preTestWorkerSha256
        Write-Host "PRE_TEST_WORKER_SHA256=$preTestWorkerSha256"
        Write-Host "RESTORED_WORKER_SHA256=$restoredWorkerSha256"
        Write-Host ('WORKER_RESTORE_HASH_MATCH=' + ([bool]$workerMatches).ToString().ToLowerInvariant())
        return ([bool]$configMatches -and [bool]$workerMatches)
    }

    $workerPresentAfter = Test-Path -LiteralPath $workerPath
    Write-Host 'PRE_TEST_WORKER_PRESENT=false'
    Write-Host ('RESTORED_WORKER_PRESENT=' + ([bool]$workerPresentAfter).ToString().ToLowerInvariant())
    Write-Host ('WORKER_RESTORE_HASH_MATCH=' + (-not $workerPresentAfter).ToString().ToLowerInvariant())
    return ([bool]$configMatches -and -not $workerPresentAfter)
}

function Invoke-CodexDevinCollapseAutomaticRestore {
    if (-not $switchAttempted -or [string]::IsNullOrWhiteSpace($newRunDirectory)) { return }

    $runState = Get-CodexDevinCollapseRunState -Directory $newRunDirectory
    if ($null -eq $runState) {
        throw "The new recovery run has no readable state manifest: $newRunDirectory"
    }
    if ($runState.status -notin @('Restored', 'ResolvedBeforeSwitch')) {
        $activeProcesses = @(Get-CodexDevinCollapseDesktopProcesses)
        if ($activeProcesses.Count -gt 0) {
            throw 'Codex Desktop/app-server is still active; automatic restore is blocked.'
        }

        $unresolved = @(
            Get-CodexDevinCollapseRecoveryRecords | Where-Object { $_.State.status -notin @('Restored', 'ResolvedBeforeSwitch') }
        )
        if ($unresolved.Count -ne 1 -or $unresolved[0].Directory -cne [IO.Path]::GetFullPath($newRunDirectory)) {
            throw 'The recovery directory set is ambiguous; automatic restore is blocked.'
        }

        $script:restoreAttempted = $true
        Write-Host 'Restoring the original Codex config and worker through the guarded recovery script...'
        & $restoreScript
        $runState = Get-CodexDevinCollapseRunState -Directory $newRunDirectory
        if ($null -eq $runState -or $runState.status -notin @('Restored', 'ResolvedBeforeSwitch')) {
            throw 'The guarded restore script did not record a completed restore or safe pre-switch resolution.'
        }
    }

    $script:restoreVerified = Write-CodexDevinCollapseRestoreHashes
    if (-not $script:restoreVerified) { throw 'Independent post-restore hash verification did not match the pre-test files.' }
}

try {
    Write-Host '[1/7] Checking profile, required scripts, catalog, and existing recovery state...'
    Assert-CodexDevinProfile
    $requiredPaths = @($configPath, $enableScript, $restoreScript)
    if (-not $isRemoteGateway) {
        $requiredPaths += @($gatewayLauncher, $oauthHelperPath, $bunPath, (Join-Path $gatewayRoot 'src\server.ts'))
    }
    foreach ($requiredPath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required file is missing: $requiredPath" }
    }
    if (-not $isRemoteGateway -and -not (Test-Path -LiteralPath (Join-Path $gatewayRoot 'node_modules') -PathType Container)) {
        throw 'The clean-fork gateway dependencies are missing; this wrapper will not install or update them.'
    }
    Assert-CodexDevinCollapseNoUnresolvedRecovery

    Write-Host '[2/7] Checking that Codex Desktop and app-server are closed...'
    Assert-CodexDevinStopped

    $gatewaySelection = Invoke-CodexDevinGatewayPreflight `
        -GatewayUrl $GatewayUrl `
        -RemoteHealthProbe {
            param($healthUri)
            Get-CodexDevinCollapseJson -Uri $healthUri
        } `
        -LocalGatewayStartup {
            param($target)

            Write-Host '[3/7] Checking port 38643 with bounded netstat and identifying any existing listener...'
            $listeners = @(Get-CodexDevinCollapseListeners)
            if (-not (Test-CodexDevinGatewayPortAvailable -Listeners $listeners)) {
                throw 'Port 38643 is occupied. This wrapper never stops existing listeners; close the gateway from its own terminal, verify it is stopped, and retry.'
            }

            Write-Host '[4/7] Starting the current gateway in a separate visible PowerShell window for fresh memory-only OAuth...'
            $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $startupStatusPath = Join-Path ([IO.Path]::GetTempPath()) ('devin-gateway-startup-' + [guid]::NewGuid().ToString('N') + '.json')
            $gatewayArguments = @(
                '-NoLogo'
                '-NoProfile'
                '-ExecutionPolicy'
                'Bypass'
                '-File'
                ('"' + $gatewayLauncher + '"')
                '-CollapseCodexDesktopSystem'
                '-StartupStatusPath'
                ('"' + $startupStatusPath + '"')
                '-SafeDiagnosticPath'
                ('"' + $diagnosticPath + '"')
            )
            $launcherProcess = Start-Process -FilePath $powerShellPath -ArgumentList $gatewayArguments -WorkingDirectory $PSScriptRoot -PassThru
            Write-Host "Clean-fork gateway launcher window PID: $($launcherProcess.Id). Complete the fresh Devin sign-in in its browser flow; leave it open."
            Wait-CodexDevinCollapseGatewayReady -LauncherProcess $launcherProcess -StartupStatusPath $startupStatusPath -Target $target
            return [pscustomobject]@{ LauncherProcess = $launcherProcess; StartupStatusPath = $startupStatusPath }
        }
    $gatewayTarget = $gatewaySelection.Target
    if ($isRemoteGateway) {
        Write-Host "Remote gateway preflight passed: $($gatewayTarget.HealthUri) returned status=ok and collapse_system_enabled=true. Local gateway startup and port checks were skipped."
        if ($WorkerTest) {
            Write-Host 'Checking devhub fallback-token state before changing Codex configuration...'
            $remoteAuthentication = Invoke-CodexDevinRemoteAuthentication `
                -InitialHealth $gatewaySelection.RemoteHealth `
                -HealthProbe { Get-CodexDevinCollapseJson -Uri $gatewayTarget.HealthUri } `
                -InteractiveLogin { param($sshTarget, $directory) Invoke-CodexDevinRemoteSshCommand -SshTarget $sshTarget -RemoteGatewayDirectory $directory -IdentityFile $RemoteSshIdentityFile -Action Login } `
                -RestartGateway { param($sshTarget, $directory) Invoke-CodexDevinRemoteSshCommand -SshTarget $sshTarget -RemoteGatewayDirectory $directory -IdentityFile $RemoteSshIdentityFile -Action Restart } `
                -SshTarget $RemoteSshTarget `
                -RemoteGatewayDirectory $RemoteGatewayDirectory
            if ($remoteAuthentication.LoginPerformed) {
                Write-Host 'Remote Devin login completed and devin-gateway was recreated; bounded health checks confirmed fallback_token=set.'
            } else {
                Write-Host 'Remote gateway already reports fallback_token=set; interactive login and gateway restart were skipped.'
            }
        }
    } else {
        $gatewayShell = $gatewaySelection.LocalStartup.LauncherProcess
        $gatewayStartupStatusPath = $gatewaySelection.LocalStartup.StartupStatusPath
        Write-Host 'Local gateway preflight: health=ok; collapse_system_enabled=true; required models=present; listener=127.0.0.1:38643.'
    }

    Write-Host '[5/7] Capturing the immediate pre-switch config and worker baseline...'
    if ((Get-Item -LiteralPath $configPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Codex config is a reparse point; refusing to switch it.'
    }
    $preTestConfigSha256 = Get-CodexDevinSha256 -Path $configPath
    if (Test-Path -LiteralPath $workerPath) {
        $workerItem = Get-Item -LiteralPath $workerPath -Force
        if ($workerItem.PSIsContainer -or ($workerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The existing SWE worker path is not a regular file; refusing to switch it.'
        }
        $preTestWorkerExists = $true
        $preTestWorkerSha256 = Get-CodexDevinSha256 -Path $workerPath
    }
    $existingDirectories = @{}
    foreach ($directory in @(Get-CodexDevinCollapseRecoveryDirectories)) { $existingDirectories[$directory] = $true }

    Write-Host '[6/7] Creating a fresh guarded backup and enabling temporary Devin mode...'
    $switchAttempted = $true
    $enableErrorWriter = [IO.StringWriter]::new()
    $originalConsoleError = [Console]::Error
    $enableException = $null
    $enableErrorText = ''
    try {
        [Console]::SetError($enableErrorWriter)
        try {
            & $enableScript -GatewayBaseUrl $gatewayTarget.BaseUrl
        } catch {
            $enableException = $_.Exception
        }
    } finally {
        [Console]::SetError($originalConsoleError)
        $enableErrorText = $enableErrorWriter.ToString()
        $enableErrorWriter.Dispose()
    }
    if ($enableException) {
        $enableFailureLine = $enableErrorText -split '\r?\n' |
            Where-Object { $_ -match '^Enable failed: ' } |
            Select-Object -Last 1
        if ($enableFailureLine) {
            $enableDetail = $enableFailureLine.Substring('Enable failed: '.Length)
            $enableDetail = $enableDetail -replace '(?i)\b(bearer)\s+\S+', '$1 [redacted]'
            $enableDetail = $enableDetail -replace '(?i)\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)\b\s*[:=]\s*\S+', '$1=[redacted]'
            if ($enableDetail.Length -gt 500) { $enableDetail = $enableDetail.Substring(0, 500) + '...' }
            [Console]::Error.WriteLine('Enable detail: ' + $enableDetail)
        } else {
            [Console]::Error.WriteLine('Enable detail: no sanitized diagnostic was emitted by Enable-CodexDevin.ps1.')
        }
        throw $enableException
    }
    if ($enableErrorText) { [Console]::Error.Write($enableErrorText) }
    $newRunDirectory = Get-CodexDevinCollapseNewRun -ExistingDirectories $existingDirectories
    if ([string]::IsNullOrWhiteSpace($newRunDirectory)) { throw 'Enable returned without creating a fresh recovery record.' }
    if ($isRemoteGateway) {
        $remoteHealth = Get-CodexDevinCollapseJson -Uri $gatewayTarget.HealthUri
        if (-not (Test-CodexDevinRemoteGatewayHealth -Health $remoteHealth)) {
            throw 'Remote gateway health no longer reports status=ok and collapse_system_enabled=true after the guarded config switch; automatic restore will run.'
        }
        if ($WorkerTest -and (Get-CodexDevinFallbackTokenState -Health $remoteHealth) -cne 'set') {
            throw 'Remote gateway no longer reports fallback_token=set after the guarded config switch; automatic restore will run.'
        }
    }
    $runState = Get-CodexDevinCollapseRunState -Directory $newRunDirectory
    if ($null -eq $runState -or $runState.status -cne 'Enabled') { throw 'Enable did not finish in the expected Enabled state.' }
    if ($runState.configOriginalSha256 -cne $preTestConfigSha256) { throw 'The enable script backup hash differs from the immediate pre-test config snapshot.' }
    if ([bool]$runState.workerExisted -ne $preTestWorkerExists) { throw 'The enable script worker baseline differs from the immediate pre-test worker snapshot.' }
    if ($preTestWorkerExists -and $runState.workerOriginalSha256 -cne $preTestWorkerSha256) { throw 'The enable script worker backup hash differs from the immediate pre-test worker snapshot.' }

    Write-Host '[7/7] Manual Desktop launch and one-request test instructions:'
    if ($WorkerTest) {
        @'
WORKER TEST READY

In Codex Desktop:
- select GLM-5.3 Flash Low
- create a NEW thread
- send EXACTLY ONCE:

Spawn exactly one agent using agent_type = swe_worker.
Do not set a reasoning effort explicitly.
Have the worker inspect package.json and report the project/package name.
Wait for that worker to finish and return its result to me.
Do not spawn any additional agents.

Then fully close Codex Desktop.
'@ | Write-Host
    } else {
        @'
LIVE COLLAPSE TEST READY

In Codex Desktop:
- select GLM-5.3 Flash Low
- create a NEW thread
- send EXACTLY ONCE:

Reply only: COLLAPSE_SYSTEM_OK

Do not send another message.
Then fully close Codex Desktop.
'@ | Write-Host
    }

    Write-Host 'Waiting up to ten minutes for Codex Desktop to start...'
    $desktopDeadline = [DateTime]::UtcNow.Add($startupTimeout)
    $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
    while ($true) {
        $desktopProcesses = @()
        $inspectionSucceeded = $true
        try { $desktopProcesses = @(Get-CodexDevinCollapseDesktopProcesses) } catch {
            $inspectionSucceeded = $false
            if ([DateTime]::UtcNow -ge $nextProgress) {
                Write-Warning 'Desktop process status is temporarily unavailable; the wrapper will not restore until it can verify the state.'
                $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
            }
        }
        $timedOut = [DateTime]::UtcNow -ge $desktopDeadline
        if ($inspectionSucceeded) {
            $action = Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $false -StartupTimedOut $timedOut -ActiveDesktopProcessCount $desktopProcesses.Count
            if ($action -ceq 'DesktopStarted') {
                $desktopWasObserved = $true
                break
            }
            if ($action -ceq 'Restore') {
                Write-Host 'Codex Desktop did not start within ten minutes; no request was sent by this wrapper. It is safe to restore.'
                break
            }
        }
        if ($timedOut -and -not $inspectionSucceeded) {
            Write-Warning 'Ten minutes elapsed, but Desktop process status could not be verified; the wrapper will attempt restore only after a fresh successful process check.'
            break
        }
        if ([DateTime]::UtcNow -ge $nextProgress) {
            Write-Host 'Waiting for Codex Desktop to start (maximum ten minutes after READY)...'
            $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
        }
        Start-Sleep -Seconds 2
    }

    if ($desktopWasObserved) {
        Write-Host 'Waiting for Codex Desktop to close before restore...'
        $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
        while ($true) {
            try {
                $desktopProcesses = @(Get-CodexDevinCollapseDesktopProcesses)
                $action = Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $true -StartupTimedOut $false -ActiveDesktopProcessCount $desktopProcesses.Count
                if ($action -ceq 'Restore') { break }
            } catch {
                if ([DateTime]::UtcNow -ge $nextProgress) {
                    Write-Warning 'Desktop process status is unavailable; continuing to wait without a timeout and without restoring.'
                    $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
                }
            }
            if ([DateTime]::UtcNow -ge $nextProgress) {
                Write-Host 'Codex Desktop is still active; restore remains safely deferred.'
                $nextProgress = [DateTime]::UtcNow.AddSeconds(30)
            }
            Start-Sleep -Seconds 2
        }
    }
} catch {
    $failureMessage = $_.Exception.Message
} finally {
    if ($switchAttempted -and -not [string]::IsNullOrWhiteSpace($newRunDirectory)) {
        try {
            Invoke-CodexDevinCollapseAutomaticRestore
    } catch {
        $restoreFailure = $_.Exception.Message
        [Console]::Error.WriteLine('Automatic restore was not verified: ' + $restoreFailure)
        if ($restoreAttempted) {
            try {
                $script:restoreVerified = Write-CodexDevinCollapseRestoreHashes
            } catch {
                [Console]::Error.WriteLine('Independent hash reporting also failed: ' + $_.Exception.Message)
            }
        }
        [Console]::Error.WriteLine('After fully closing Codex Desktop, run:')
            [Console]::Error.WriteLine("& '$restoreScript'")
        }
    } elseif ($switchAttempted) {
        try {
            $newRunDirectory = Get-CodexDevinCollapseNewRun -ExistingDirectories $existingDirectories
            if ($newRunDirectory) {
                Invoke-CodexDevinCollapseAutomaticRestore
            }
        } catch {
            $restoreFailure = $_.Exception.Message
            [Console]::Error.WriteLine('A new recovery record could not be safely resolved: ' + $restoreFailure)
            if ($restoreAttempted) {
                try {
                    $script:restoreVerified = Write-CodexDevinCollapseRestoreHashes
                } catch {
                    [Console]::Error.WriteLine('Independent hash reporting also failed: ' + $_.Exception.Message)
                }
            }
            [Console]::Error.WriteLine('After fully closing Codex Desktop, run:')
            [Console]::Error.WriteLine("& '$restoreScript'")
        }
    }

    if ($newRunDirectory -and ($restoreVerified -or $restoreFailure)) {
        if ($isRemoteGateway) {
            Write-Host "Remote gateway: $($gatewayTarget.RootUrl). This wrapper does not read or expose remote diagnostic files."
        } elseif ($diagnosticPath) {
            Write-Host "Safe gateway diagnostic: $diagnosticPath"
        }
        if ($gatewayShell -and -not $gatewayShell.HasExited) {
            Write-Host 'The separately authenticated gateway remains in its visible window. Press Ctrl+C there when finished.'
        }
    }
    if ($gatewayStartupStatusPath -and (Test-Path -LiteralPath $gatewayStartupStatusPath -PathType Leaf)) {
        try { Remove-Item -LiteralPath $gatewayStartupStatusPath -Force -ErrorAction Stop } catch {
            [Console]::Error.WriteLine('Could not remove the temporary gateway startup status file; it contains only an allowlisted error code.')
        }
    }
}

if ($failureMessage) {
    [Console]::Error.WriteLine($testName + ' wrapper stopped: ' + $failureMessage)
    if ($gatewayShell -and -not $gatewayShell.HasExited -and -not $newRunDirectory) {
        [Console]::Error.WriteLine('The gateway may still be running in its separate visible window. Press Ctrl+C there before retrying.')
    }
    if ($restoreFailure) { throw 'The wrapper stopped and automatic restore needs manual recovery; follow the guarded restore command above.' }
    throw 'The wrapper stopped. Review the message above; any completed config switch was restored and hash-checked.'
}
if ($restoreFailure) { throw 'The wrapper could not verify automatic restore; follow the guarded restore command above.' }
if (-not $restoreVerified) { throw 'No verified restore was recorded; inspect the recovery state before continuing.' }
Write-Host ($testName + ' finished; the original Codex config and worker state were independently verified.')
