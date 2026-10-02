[CmdletBinding()]
param(
    [switch]$CollapseCodexDesktopSystem,
    [string]$StartupStatusPath,
    [string]$SafeDiagnosticPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')
Import-Module (Join-Path $PSScriptRoot 'CodexDevin.CollapseTest.Guards.psm1') -Force

$gatewayRoot = Resolve-CodexDevinGatewayRoot -ToolDirectory $PSScriptRoot
$oauthHelperPath = Join-Path $PSScriptRoot 'DevinOAuthBridge.ts'
$serverPath = Join-Path $gatewayRoot 'src\server.ts'
$bunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$gatewayPort = 38643
$callbackPort = 59653
$reviewedSourceSha256 = '599E507FE80F97BA36CCFA42FD0E641D06346AEE905E65B9F2E2074A2F5D4B0C'

function Write-SafeStartupStatus([string]$Code) {
    if ([string]::IsNullOrWhiteSpace($StartupStatusPath)) { return }
    try {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
        $fullPath = [IO.Path]::GetFullPath($StartupStatusPath)
        $parent = [IO.Path]::GetDirectoryName($fullPath)
        $leaf = [IO.Path]::GetFileName($fullPath)
        if (-not [string]::Equals($parent, $tempRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
        if ($leaf -notmatch '^devin-gateway-startup-[a-fA-F0-9]{32}\.json$') { return }
        if (Test-Path -LiteralPath $fullPath) { return }
        $payload = @{ version = 1; code = $Code } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($fullPath, $payload, [Text.UTF8Encoding]::new($false))
    } catch {
        # The visible gateway window remains the source of local diagnostics.
    }
}

function Get-SafeStartupFailureCode([string]$Message) {
    if ($Message -match 'reviewed clean-fork source, package manifest, or lockfile has changed') { return 'source_fingerprint_mismatch' }
    if ($Message -match '^Local TCP port 38643 is already in use') { return 'gateway_port_occupied' }
    if ($Message -match '^Local TCP port 59653 is already in use') { return 'callback_port_occupied' }
    if ($Message -match '^A service already returns status=ok from /health') { return 'gateway_already_healthy' }
    if ($Message -match '^Bun was not found') { return 'bun_not_found' }
    if ($Message -match '^The clean-fork dependencies are missing') { return 'dependencies_missing' }
    if ($Message -match '^The clean-fork OAuth gateway exited with code \d+\.') { return 'bridge_exit_nonzero' }
    return 'gateway_startup_failed'
}

function Assert-LoopbackPortFree([int]$Port) {
    if (-not (Test-CodexDevinLoopbackPortFree -Port $Port)) {
        throw "Local TCP port $Port is already in use. No process was stopped."
    }
}

try {
    Write-Host '[1/5] Resolving the clean-fork root and hashing reviewed runtime inputs...'
    if (-not (Test-Path -LiteralPath $oauthHelperPath -PathType Leaf) -or -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw "The clean-fork gateway or its memory-only OAuth helper is missing under $gatewayRoot"
    }
    if (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $gatewayRoot -OAuthHelperPath $oauthHelperPath -ExpectedFingerprint $reviewedSourceSha256)) {
        throw 'The reviewed clean-fork source, package manifest, or lockfile has changed; inspect it before starting.'
    }
    Write-Host '[2/5] Checking the installed Bun executable and existing dependencies...'
    if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) { throw "Bun was not found at the expected per-user path: $bunPath" }
    if (-not (Test-Path -LiteralPath (Join-Path $gatewayRoot 'node_modules') -PathType Container)) { throw 'The clean-fork dependencies are missing; this launcher will not install or change them.' }

    Write-Host '[3/5] Checking gateway health on loopback (maximum 3 seconds)...'
    $health = Get-CodexDevinGatewayHealth -Uri "http://127.0.0.1:$gatewayPort/health"
    if ($health.Healthy) {
        throw "A service already returns status=ok from /health at http://127.0.0.1:$gatewayPort. This launcher cannot verify its Devin OAuth identity and did not start another process."
    }
    Write-Host 'No healthy gateway response was received; checking whether the required loopback ports are free.'

    Write-Host '[4/5] Checking the two loopback ports with local bounded bind probes...'
    Assert-LoopbackPortFree -Port $gatewayPort
    Assert-LoopbackPortFree -Port $callbackPort

    $names = @(
        'DEBUG', 'ERROR_TRACE', 'ERROR_TRACE_DIR', 'DEVIN_GATEWAY_PORT',
        'DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM',
        'DEVIN_RESPONSES_SAFE_DIAGNOSTICS', 'DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH',
        'DEVIN_API_KEY', 'DEFAULT_DEVIN_KEY', 'DEVIN_TOKEN', 'DEVIN_BASE_URL',
        'DEVIN_GATEWAY_CONFIG_DIR', 'DEVIN_TOOL_DELTA_AUDIT', 'DEVIN_TOOL_WIRE_AUDIT',
        'HOST', 'PORT', 'LOG_FILE', 'LOG_LEVEL'
    )
    $savedEnvironment = @{}
    foreach ($name in $names) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        [Environment]::SetEnvironmentVariable('DEBUG', 'false', 'Process')
        [Environment]::SetEnvironmentVariable('ERROR_TRACE', 'false', 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_GATEWAY_PORT', [string]$gatewayPort, 'Process')
        if ($CollapseCodexDesktopSystem) {
            [Environment]::SetEnvironmentVariable('DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM', '1', 'Process')
            Write-Host 'System collapse enabled for the guarded clean-fork Desktop worker test.'
        } else {
            [Environment]::SetEnvironmentVariable('DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM', $null, 'Process')
        }
        [Environment]::SetEnvironmentVariable('DEVIN_API_KEY', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEFAULT_DEVIN_KEY', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_TOKEN', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_BASE_URL', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_GATEWAY_CONFIG_DIR', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_TOOL_DELTA_AUDIT', $null, 'Process')
        [Environment]::SetEnvironmentVariable('DEVIN_TOOL_WIRE_AUDIT', $null, 'Process')
        [Environment]::SetEnvironmentVariable('ERROR_TRACE_DIR', $null, 'Process')
        [Environment]::SetEnvironmentVariable('HOST', $null, 'Process')
        [Environment]::SetEnvironmentVariable('PORT', $null, 'Process')
        [Environment]::SetEnvironmentVariable('LOG_FILE', $null, 'Process')
        [Environment]::SetEnvironmentVariable('LOG_LEVEL', $null, 'Process')
        if ([string]::IsNullOrWhiteSpace($SafeDiagnosticPath)) {
            [Environment]::SetEnvironmentVariable('DEVIN_RESPONSES_SAFE_DIAGNOSTICS', $null, 'Process')
            [Environment]::SetEnvironmentVariable('DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH', $null, 'Process')
        } else {
            $fullDiagnosticPath = [IO.Path]::GetFullPath($SafeDiagnosticPath)
            $expectedLogDirectory = [IO.Path]::GetFullPath((Join-Path $gatewayRoot 'logs')).TrimEnd([char[]]@('\', '/'))
            $diagnosticDirectory = [IO.Path]::GetDirectoryName($fullDiagnosticPath).TrimEnd([char[]]@('\', '/'))
            $diagnosticLeaf = [IO.Path]::GetFileName($fullDiagnosticPath)
            if (-not [string]::Equals($diagnosticDirectory, $expectedLogDirectory, [StringComparison]::OrdinalIgnoreCase) -or $diagnosticLeaf -notmatch '^responses-safe-diagnostic-[a-fA-F0-9]{32}\.jsonl$') {
                throw 'Safe diagnostics must use a fresh GUID-named JSONL file directly under the clean-fork logs directory.'
            }
            [Environment]::SetEnvironmentVariable('DEVIN_RESPONSES_SAFE_DIAGNOSTICS', '1', 'Process')
            [Environment]::SetEnvironmentVariable('DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH', $fullDiagnosticPath, 'Process')
            Write-Host 'Safe allowlisted Responses diagnostics are explicitly enabled; raw diagnostics remain disabled.'
        }
        Write-Host '[5/5] Starting the clean-fork loopback gateway with memory-only Devin OAuth in this PowerShell session.'
        Write-Host 'Complete the one-time sign-in in your browser, then leave this window open for the test.'
        Push-Location $gatewayRoot
        try {
            & $bunPath run --no-env-file $oauthHelperPath
            if ($LASTEXITCODE -ne 0) { throw "The clean-fork OAuth gateway exited with code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
} catch {
    $safeCode = Get-SafeStartupFailureCode -Message ([string]$_.Exception.Message)
    Write-SafeStartupStatus -Code $safeCode
    [Console]::Error.WriteLine("Gateway start failed ($safeCode). The wrapper receives only this allowlisted failure category.")
    throw 'Gateway did not start. Review the sanitized failure category above.'
}
