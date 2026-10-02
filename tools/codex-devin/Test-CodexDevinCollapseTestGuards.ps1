[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexDevin.CollapseTest.Guards.psm1') -Force

$script:passed = 0
function Assert-CollapseGuard([string]$Name, [bool]$Actual, [bool]$Expected) {
    if ($Actual -ne $Expected) { throw "FAIL: $Name (expected $Expected, got $Actual)" }
    $script:passed++
    Write-Host "PASS: $Name"
}

$boundedProcess = [pscustomobject]@{ ExitCode = 0; Killed = $false; WaitMilliseconds = 0 }
$boundedProcess | Add-Member ScriptMethod WaitForExit { param($Milliseconds) $this.WaitMilliseconds = $Milliseconds; return $false }
$boundedProcess | Add-Member ScriptMethod Kill { $this.Killed = $true }
$timedOut = $false
try {
    $null = Invoke-CodexDevinAttachedProcess -FilePath 'synthetic-ssh' -Arguments @('synthetic') -TimeoutSeconds 2 -ProcessStarter { param($File, $Arguments) return $boundedProcess }
} catch { $timedOut = $_.Exception.Message -like '*bounded timeout*' }
Assert-CollapseGuard 'restart timeout stops only its owned child and fails closed' ($timedOut -and $boundedProcess.Killed -and $boundedProcess.WaitMilliseconds -eq 2000) $true

$netstat = @(
    '  TCP    127.0.0.1:38643      0.0.0.0:0              LISTENING       34560'
    '  TCP    0.0.0.0:38643        0.0.0.0:0              LISTENING       777'
    '  TCP    [::1]:38643          [::]:0                 LISTENING       778'
    '  TCP    127.0.0.1:38644      0.0.0.0:0              LISTENING       999'
    '  TCP    127.0.0.1:38643      192.0.2.4:40000        ESTABLISHED     222'
)
$listeners = @(Get-CodexDevinCollapsePortListeners -NetstatLines $netstat -Port 38643)
Assert-CollapseGuard 'netstat parser finds only target-port listeners' ($listeners.Count -eq 3) $true
Assert-CollapseGuard 'netstat parser keeps listener PID and IPv4 address' ($listeners[0].ProcessId -eq 34560 -and $listeners[0].LocalAddress -ceq '127.0.0.1') $true
Assert-CollapseGuard 'netstat parser normalizes loopback IPv6 address' ($listeners[2].LocalAddress -ceq '::1') $true
$emptyListeners = @(Get-CodexDevinCollapsePortListeners -NetstatLines @() -Port 38643)
Assert-CollapseGuard 'empty netstat output is treated as no listeners' ($emptyListeners.Count -eq 0) $true
$emptyStringListeners = @(Get-CodexDevinCollapsePortListeners -NetstatLines '' -Port 38643)
Assert-CollapseGuard 'empty-string netstat output is treated as no listeners' ($emptyStringListeners.Count -eq 0) $true
Assert-CollapseGuard 'an empty listener set passes the fail-closed port guard' (Test-CodexDevinGatewayPortAvailable -Listeners @()) $true
Assert-CollapseGuard 'any existing listener blocks gateway startup without stopping it' (-not (Test-CodexDevinGatewayPortAvailable -Listeners $listeners)) $true

$boundPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$boundPortProbe.Start()
$boundPort = ([Net.IPEndPoint]$boundPortProbe.LocalEndpoint).Port
try {
    Assert-CollapseGuard 'an occupied loopback port fails the actual bind probe' (-not (Test-CodexDevinLoopbackPortFree -Port $boundPort)) $true
} finally {
    $boundPortProbe.Stop()
}
Assert-CollapseGuard 'a released loopback port passes the actual bind probe' (Test-CodexDevinLoopbackPortFree -Port $boundPort) $true

$healthEnabled = [pscustomobject]@{ status = 'ok'; fallback_token = 'set'; collapse_system_enabled = $true }
$healthNotAuthenticated = [pscustomobject]@{ status = 'ok'; fallback_token = 'not_set'; collapse_system_enabled = $true }
$healthDisabled = [pscustomobject]@{ status = 'ok'; fallback_token = 'not_set'; collapse_system_enabled = $false }
$models = @('glm-5-3-flash-low', 'swe-2-medium')

$script:localGatewayStartupCalls = 0
$script:remoteHealthProbeCalls = 0
$defaultRoute = Invoke-CodexDevinGatewayPreflight `
    -RemoteHealthProbe { param($uri) $script:remoteHealthProbeCalls = $script:remoteHealthProbeCalls + 1; return $healthEnabled } `
    -LocalGatewayStartup { param($target) $script:localGatewayStartupCalls = $script:localGatewayStartupCalls + 1; return [pscustomobject]@{ BaseUrl = $target.BaseUrl } }
Assert-CollapseGuard 'omitting GatewayUrl keeps the localhost provider URL' ($defaultRoute.Target.BaseUrl -ceq 'http://127.0.0.1:38643/v1') $true
Assert-CollapseGuard 'omitting GatewayUrl invokes the existing local startup path only' ($script:localGatewayStartupCalls -eq 1 -and $script:remoteHealthProbeCalls -eq 0) $true

$script:localGatewayStartupCalls = 0
$script:remoteHealthProbeCalls = 0
$script:remoteHealthProbeUri = $null
$remoteRoute = Invoke-CodexDevinGatewayPreflight `
    -GatewayUrl 'http://192.0.2.10:38643' `
    -RemoteHealthProbe { param($uri) $script:remoteHealthProbeCalls = $script:remoteHealthProbeCalls + 1; $script:remoteHealthProbeUri = $uri; return $healthEnabled } `
    -LocalGatewayStartup { param($target) $script:localGatewayStartupCalls = $script:localGatewayStartupCalls + 1; return [pscustomobject]@{ BaseUrl = $target.BaseUrl } }
Assert-CollapseGuard 'healthy remote target writes its /v1 provider base URL' ($remoteRoute.Target.BaseUrl -ceq 'http://192.0.2.10:38643/v1') $true
Assert-CollapseGuard 'healthy remote target probes its own /health endpoint' ($script:remoteHealthProbeUri -ceq 'http://192.0.2.10:38643/health' -and $script:remoteHealthProbeCalls -eq 1) $true
Assert-CollapseGuard 'healthy remote target bypasses local gateway startup' ($script:localGatewayStartupCalls -eq 0 -and $null -eq $remoteRoute.LocalStartup) $true
Assert-CollapseGuard 'remote preflight preserves sanitized fallback-token state' ((Get-CodexDevinFallbackTokenState -Health $remoteRoute.RemoteHealth) -ceq 'set') $true
Assert-CollapseGuard 'remote health requires the collapse flag' (Test-CodexDevinRemoteGatewayHealth -Health $healthEnabled) $true
Assert-CollapseGuard 'remote health rejects a disabled collapse flag' (-not (Test-CodexDevinRemoteGatewayHealth -Health $healthDisabled)) $true
Assert-CollapseGuard 'remote health rejects non-boolean truthy collapse values' (-not (Test-CodexDevinRemoteGatewayHealth -Health ([pscustomobject]@{ status = 'ok'; collapse_system_enabled = 'true' }))) $true
Assert-CollapseGuard 'fallback-token state accepts only set or not_set' ((Get-CodexDevinFallbackTokenState -Health $healthEnabled) -ceq 'set' -and (Get-CodexDevinFallbackTokenState -Health $healthNotAuthenticated) -ceq 'not_set' -and (Get-CodexDevinFallbackTokenState -Health ([pscustomobject]@{ fallback_token = 'configured' })) -ceq 'unknown') $true

$script:remoteLoginCalls = 0
$script:remoteRestartCalls = 0
$script:remotePostLoginHealthCalls = 0
$alreadyAuthenticated = Invoke-CodexDevinRemoteAuthentication `
    -InitialHealth $healthEnabled `
    -HealthProbe { $script:remotePostLoginHealthCalls++; return $healthEnabled } `
    -InteractiveLogin { $script:remoteLoginCalls++; return $false } `
    -RestartGateway { $script:remoteRestartCalls++; return $false } `
    -SshTarget $null `
    -RemoteGatewayDirectory $null
Assert-CollapseGuard 'remote fallback_token=set skips OAuth, restart, and follow-up polling' ($alreadyAuthenticated.FallbackToken -ceq 'set' -and -not $alreadyAuthenticated.LoginPerformed -and -not $alreadyAuthenticated.GatewayRecreated -and $script:remoteLoginCalls -eq 0 -and $script:remoteRestartCalls -eq 0 -and $script:remotePostLoginHealthCalls -eq 0) $true

$script:remoteAuthEvents = @()
$script:remoteAuthHealthCalls = 0
$authenticatedAfterLogin = Invoke-CodexDevinRemoteAuthentication `
    -InitialHealth $healthNotAuthenticated `
    -HealthProbe { $script:remoteAuthHealthCalls++; return $healthEnabled } `
    -InteractiveLogin { param($target, $directory) $script:remoteAuthEvents += "login:$($target):$($directory)"; return $true } `
    -RestartGateway { param($target, $directory) $script:remoteAuthEvents += "restart:$($target):$($directory)"; return $true } `
    -SshTarget 'gateway-user@192.0.2.10' `
    -RemoteGatewayDirectory '/srv/example/services/devin-gateway' `
    -MaxHealthChecks 2 `
    -PollIntervalSeconds 0
Assert-CollapseGuard 'remote fallback_token=not_set performs interactive login, recreates gateway, and confirms health' ($authenticatedAfterLogin.LoginPerformed -and $authenticatedAfterLogin.GatewayRecreated -and $authenticatedAfterLogin.FallbackToken -ceq 'set' -and $script:remoteAuthHealthCalls -eq 1 -and $script:remoteAuthEvents.Count -eq 2 -and $script:remoteAuthEvents[0] -like 'login:*' -and $script:remoteAuthEvents[1] -like 'restart:*') $true

$script:remoteRestartCalls = 0
$loginFailureStopped = $false
try {
    $null = Invoke-CodexDevinRemoteAuthentication `
        -InitialHealth $healthNotAuthenticated `
        -HealthProbe { $healthEnabled } `
        -InteractiveLogin { $false } `
        -RestartGateway { $script:remoteRestartCalls++; return $true } `
        -SshTarget 'gateway-user@192.0.2.10' `
        -RemoteGatewayDirectory '/srv/example/services/devin-gateway' `
        -PollIntervalSeconds 0
} catch { $loginFailureStopped = $_.Exception.Message -like '*login failed*' }
Assert-CollapseGuard 'failed interactive login stops before gateway recreation' ($loginFailureStopped -and $script:remoteRestartCalls -eq 0) $true

$tokenNotSetStopped = $false
try {
    $null = Invoke-CodexDevinRemoteAuthentication `
        -InitialHealth $healthNotAuthenticated `
        -HealthProbe { $healthNotAuthenticated } `
        -InteractiveLogin { $true } `
        -RestartGateway { $true } `
        -SshTarget 'gateway-user@192.0.2.10' `
        -RemoteGatewayDirectory '/srv/example/services/devin-gateway' `
        -MaxHealthChecks 2 `
        -PollIntervalSeconds 0
} catch { $tokenNotSetStopped = $_.Exception.Message -like '*fallback_token=set*' }
Assert-CollapseGuard 'fallback_token=not_set after restart fails closed' $tokenNotSetStopped $true

Assert-CollapseGuard 'SSH target rejects option injection' (-not (Test-CodexDevinSshTarget -SshTarget '-oProxyCommand=bad')) $true
Assert-CollapseGuard 'interactive login SSH options include the supplied identity file and allocate a TTY' ((@(Get-CodexDevinRemoteSshOptions -Action Login -IdentityFile $PSCommandPath) -join '|') -ceq "-i|$PSCommandPath|-o|IdentitiesOnly=yes|-t") $true
Assert-CollapseGuard 'gateway restart SSH options include the supplied identity file without allocating a TTY' ((@(Get-CodexDevinRemoteSshOptions -Action Restart -IdentityFile $PSCommandPath) -join '|') -ceq "-i|$PSCommandPath|-o|IdentitiesOnly=yes|-T") $true
Assert-CollapseGuard 'SSH options preserve agent/default identity behavior when no file is supplied' ((@(Get-CodexDevinRemoteSshOptions -Action Login) -join '|') -ceq '-t') $true
$missingIdentityRejected = $false
try { $null = Get-CodexDevinRemoteSshOptions -Action Login -IdentityFile (Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))) } catch { $missingIdentityRejected = $true }
Assert-CollapseGuard 'SSH identity file must exist before remote auth begins' $missingIdentityRejected $true
Assert-CollapseGuard 'interactive SSH command explicitly forwards stdin without allocating a nested Compose TTY' ((New-CodexDevinRemoteComposeCommand -Action Login -RemoteGatewayDirectory '/srv/example/services/devin-gateway') -ceq "cd '/srv/example/services/devin-gateway' && sudo -n docker compose run --rm --interactive --no-TTY devin-login") $true
Assert-CollapseGuard 'restart SSH command uses non-interactive sudo and recreates only the gateway service' ((New-CodexDevinRemoteComposeCommand -Action Restart -RemoteGatewayDirectory '/srv/example/services/devin-gateway') -ceq "cd '/srv/example/services/devin-gateway' && sudo -n docker compose up -d --force-recreate devin-gateway") $true
$quotedWindowsArgument = ConvertTo-CodexDevinWindowsCommandLineArgument -Argument 'C:\Example Data\ssh.exe'
Assert-CollapseGuard 'Windows process arguments with spaces are quoted as one argument' ($quotedWindowsArgument -ceq '"C:\Example Data\ssh.exe"') $true
$script:mockProcessArguments = $null
$successfulMockProcess = { param($filePath, $argumentLine) $script:mockProcessArguments = $argumentLine; [pscustomobject]@{ ExitCode = 0 } }
$successfulProcessOutput = @(Invoke-CodexDevinAttachedProcess -FilePath 'ssh.exe' -Arguments @('-t', 'gateway-user@192.0.2.1', "cd '/srv/example space' && docker compose run devin-login") -ProcessStarter $successfulMockProcess)
Assert-CollapseGuard 'attached process reports success as one boolean without leaking child output into the result' ($successfulProcessOutput.Count -eq 1 -and $successfulProcessOutput[0] -is [bool] -and $successfulProcessOutput[0]) $true
Assert-CollapseGuard 'attached process keeps the SSH remote command as one correctly quoted argument' ($script:mockProcessArguments -match '"cd ''/srv/example space'' && docker compose run devin-login"$') $true
$failedMockProcess = { param($filePath, $argumentLine) [pscustomobject]@{ ExitCode = 255 } }
$failedProcessOutput = @(Invoke-CodexDevinAttachedProcess -FilePath 'ssh.exe' -Arguments @('-t', 'gateway-user@192.0.2.1', 'false') -ProcessStarter $failedMockProcess)
Assert-CollapseGuard 'attached process failure remains a false boolean' ($failedProcessOutput.Count -eq 1 -and $failedProcessOutput[0] -is [bool] -and -not $failedProcessOutput[0]) $true
Assert-CollapseGuard 'remote path quoting preserves spaces' ((ConvertTo-CodexDevinRemoteShellPath -Path '/srv/example space/gateway') -ceq "'/srv/example space/gateway'") $true
Assert-CollapseGuard 'remote path quoting safely escapes embedded quotes' ((ConvertTo-CodexDevinRemoteShellPath -Path "/srv/example/o'connor") -ceq "'/srv/example/o'`"'`"'connor'") $true

$script:localGatewayStartupCalls = 0
$script:remoteHealthProbeCalls = 0
$remoteFailedClosed = $false
try {
    $null = Invoke-CodexDevinGatewayPreflight `
        -GatewayUrl 'http://192.0.2.10:38643' `
        -RemoteHealthProbe { param($uri) $script:remoteHealthProbeCalls = $script:remoteHealthProbeCalls + 1; return $healthDisabled } `
        -LocalGatewayStartup { param($target) $script:localGatewayStartupCalls = $script:localGatewayStartupCalls + 1; return $null }
} catch {
    $remoteFailedClosed = $_.Exception.Message -like '*localhost was not started*'
}
Assert-CollapseGuard 'unhealthy remote target fails closed' $remoteFailedClosed $true
Assert-CollapseGuard 'unhealthy remote target never falls back to localhost' ($script:remoteHealthProbeCalls -eq 1 -and $script:localGatewayStartupCalls -eq 0) $true

$script:localGatewayStartupCalls = 0
$requestFailureClosed = $false
try {
    $null = Invoke-CodexDevinGatewayPreflight `
        -GatewayUrl 'http://192.0.2.10:38643' `
        -RemoteHealthProbe { throw 'synthetic timeout' } `
        -LocalGatewayStartup { param($target) $script:localGatewayStartupCalls = $script:localGatewayStartupCalls + 1; return $null }
} catch {
    $requestFailureClosed = $_.Exception.Message -like '*localhost was not started*'
}
Assert-CollapseGuard 'remote health request errors fail closed without local startup' ($requestFailureClosed -and $script:localGatewayStartupCalls -eq 0) $true

$remoteTarget = Resolve-CodexDevinGatewayTarget -GatewayUrl 'http://192.0.2.10:38643/'
Assert-CollapseGuard 'remote target accepts only an origin and canonicalizes its provider URL' ($remoteTarget.IsRemote -and $remoteTarget.BaseUrl -ceq 'http://192.0.2.10:38643/v1') $true
$invalidRemoteRejected = $false
try { $null = Resolve-CodexDevinGatewayTarget -GatewayUrl 'http://user@192.0.2.10:38643' } catch { $invalidRemoteRejected = $true }
Assert-CollapseGuard 'gateway target rejects embedded URL credentials' $invalidRemoteRejected $true

Assert-CollapseGuard 'ready check requires collapse flag and valid nonempty discovery' (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds $models) $true
Assert-CollapseGuard 'ready check waits safely when health has not started responding' (-not (Test-CodexDevinCollapseGatewayReady -Health $null -ModelIds @())) $true
Assert-CollapseGuard 'ready check rejects a disabled collapse flag' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthDisabled -ModelIds $models)) $true
Assert-CollapseGuard 'discovery readiness is not tied to the old parent/worker pair; manifest validates saved roles separately' (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('swe-2-medium')) $true
Assert-CollapseGuard 'discovery readiness rejects malformed IDs' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('invalid model'))) $true
Assert-CollapseGuard 'discovery readiness rejects duplicate IDs' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('swe-2-medium', 'swe-2-medium'))) $true
Assert-CollapseGuard 'discovery readiness accepts a valid nonempty list before saved-role validation' (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('glm-5-3-flash-low')) $true
Assert-CollapseGuard 'restore is permitted only after switch attempt and Desktop exit' (Test-CodexDevinCollapseRestoreSafe -SwitchAttempted $true -ActiveDesktopProcessCount 0) $true
Assert-CollapseGuard 'restore is blocked while Desktop remains active' (-not (Test-CodexDevinCollapseRestoreSafe -SwitchAttempted $true -ActiveDesktopProcessCount 1)) $true
Assert-CollapseGuard 'restore is not attempted when switch never started' (-not (Test-CodexDevinCollapseRestoreSafe -SwitchAttempted $false -ActiveDesktopProcessCount 0)) $true
Assert-CollapseGuard 'startup wait continues before the ten-minute deadline' ((Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $false -StartupTimedOut $false -ActiveDesktopProcessCount 0) -ceq 'WaitForStart') $true
Assert-CollapseGuard 'startup timeout restores only with no active Desktop process' ((Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $false -StartupTimedOut $true -ActiveDesktopProcessCount 0) -ceq 'Restore') $true
Assert-CollapseGuard 'an observed Desktop process starts the unbounded close-wait phase' ((Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $false -StartupTimedOut $true -ActiveDesktopProcessCount 1) -ceq 'DesktopStarted') $true
Assert-CollapseGuard 'once started, an active Desktop process is never timed out' ((Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $true -StartupTimedOut $true -ActiveDesktopProcessCount 1) -ceq 'WaitForClose') $true
Assert-CollapseGuard 'once started, restore follows verified Desktop exit' ((Get-CodexDevinCollapseDesktopWaitAction -DesktopStarted $true -StartupTimedOut $false -ActiveDesktopProcessCount 0) -ceq 'Restore') $true

$startupStatusPath = Join-Path ([IO.Path]::GetTempPath()) ('devin-gateway-startup-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($startupStatusPath, '{"version":1,"code":"source_fingerprint_mismatch","message":"Bearer SYNTHETIC_SECRET"}', [Text.UTF8Encoding]::new($false))
    $safeStartupMessage = Get-CodexDevinGatewayStartupFailureMessage -StatusPath $startupStatusPath
    Assert-CollapseGuard 'startup status exposes the sanitized clean-fork fingerprint category' ($safeStartupMessage -like '*stale reviewed clean-fork fingerprint*') $true
    Assert-CollapseGuard 'startup status never forwards arbitrary error or secret fields' (-not $safeStartupMessage.Contains('SYNTHETIC_SECRET') -and -not $safeStartupMessage.Contains('Bearer')) $true

    [IO.File]::WriteAllText($startupStatusPath, '{"version":1,"code":"unknown","message":"private detail"}', [Text.UTF8Encoding]::new($false))
    Assert-CollapseGuard 'unknown startup status codes are not surfaced' ($null -eq (Get-CodexDevinGatewayStartupFailureMessage -StatusPath $startupStatusPath)) $true

    [IO.File]::WriteAllText($startupStatusPath, '{"version":"invalid","code":"source_fingerprint_mismatch"}', [Text.UTF8Encoding]::new($false))
    Assert-CollapseGuard 'malformed startup status versions safely fall back to the generic wrapper error' ($null -eq (Get-CodexDevinGatewayStartupFailureMessage -StatusPath $startupStatusPath)) $true
} finally {
    if (Test-Path -LiteralPath $startupStatusPath) { Remove-Item -LiteralPath $startupStatusPath -Force }
}

Write-Host "PASS: $script:passed synthetic collapse-wrapper guard checks"
