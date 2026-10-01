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

$healthEnabled = [pscustomobject]@{ status = 'ok'; fallback_token = 'not_set'; collapse_system_enabled = $true }
$healthDisabled = [pscustomobject]@{ status = 'ok'; fallback_token = 'not_set'; collapse_system_enabled = $false }
$models = @('glm-5-3-flash-low', 'swe-2-medium')

Assert-CollapseGuard 'ready check requires collapse flag and both models' (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds $models) $true
Assert-CollapseGuard 'ready check waits safely when health has not started responding' (-not (Test-CodexDevinCollapseGatewayReady -Health $null -ModelIds @())) $true
Assert-CollapseGuard 'ready check rejects a disabled collapse flag' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthDisabled -ModelIds $models)) $true
Assert-CollapseGuard 'ready check rejects missing GLM model' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('swe-2-medium'))) $true
Assert-CollapseGuard 'ready check rejects missing SWE-2 Medium model' (-not (Test-CodexDevinCollapseGatewayReady -Health $healthEnabled -ModelIds @('glm-5-3-flash-low'))) $true
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
