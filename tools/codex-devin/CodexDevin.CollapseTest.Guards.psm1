Set-StrictMode -Version Latest

function Get-CodexDevinCollapsePortListeners {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$NetstatLines,
        [ValidateRange(1, 65535)][int]$Port = 38643
    )

    $pattern = '^\s*TCP\s+(?<local>\S+):' + [regex]::Escape([string]$Port) + '\s+\S+\s+LISTENING\s+(?<pid>\d+)\s*$'
    foreach ($line in $NetstatLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch $pattern) { continue }
        $localAddress = $Matches.local
        if ($localAddress.StartsWith('[') -and $localAddress.EndsWith(']')) {
            $localAddress = $localAddress.Substring(1, $localAddress.Length - 2)
        }
        [pscustomobject]@{
            LocalAddress = $localAddress
            ProcessId = [int]$Matches.pid
        }
    }
}

function Test-CodexDevinGatewayPortAvailable {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Listeners)
    return ($Listeners.Count -eq 0)
}

function Test-CodexDevinLoopbackPortFree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port)

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        try { $listener.Stop() } catch { }
    }
}

function Resolve-CodexDevinGatewayRoot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ToolDirectory)

    $fullToolDirectory = [IO.Path]::GetFullPath($ToolDirectory).TrimEnd([char[]]@('\', '/'))
    $root = [IO.Path]::GetFullPath((Join-Path $fullToolDirectory '..\..')).TrimEnd([char[]]@('\', '/'))
    $expectedToolsDirectory = [IO.Path]::GetFullPath((Join-Path $root 'tools\codex-devin')).TrimEnd([char[]]@('\', '/'))
    if (-not [string]::Equals($fullToolDirectory, $expectedToolsDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The launcher must live under the clean gateway repository tools\codex-devin directory.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'src\server.ts') -PathType Leaf)) {
        throw 'The resolved gateway root does not contain src\server.ts.'
    }
    return $root
}

function Get-CodexDevinGatewayFingerprint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$GatewayRoot,
        [Parameter(Mandatory)][string]$OAuthHelperPath
    )

    $root = [IO.Path]::GetFullPath($GatewayRoot).TrimEnd([char[]]@('\', '/'))
    $helper = [IO.Path]::GetFullPath($OAuthHelperPath)
    $helperPrefix = $root + [IO.Path]::DirectorySeparatorChar
    if (-not $helper.StartsWith($helperPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The memory-only OAuth helper must be inside the clean gateway repository.'
    }

    $inputs = @()
    $sourceDirectory = Join-Path $root 'src'
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { throw 'Gateway src directory is missing.' }
    $inputs += @(Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File)
    foreach ($required in @((Join-Path $root 'package.json'), $helper)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Fingerprint input is missing: $required" }
        $inputs += Get-Item -LiteralPath $required
    }
    foreach ($runtimeConfigName in @('tsconfig.json', 'bunfig.toml')) {
        $runtimeConfigPath = Join-Path $root $runtimeConfigName
        if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) { $inputs += Get-Item -LiteralPath $runtimeConfigPath }
    }
    $lockfiles = @(@('bun.lock', 'bun.lockb') | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($lockfiles.Count -eq 0) { throw 'No supported Bun lockfile was found in the gateway root.' }
    foreach ($lockfile in $lockfiles) { $inputs += Get-Item -LiteralPath $lockfile }

    $entries = foreach ($file in $inputs) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Fingerprint input is a reparse point: $($file.FullName)" }
        $relativePath = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
        [pscustomobject]@{ Path = $relativePath; Hash = $hash }
    }
    $ordered = @($entries | Sort-Object -Property Path -CaseSensitive)
    $manifest = ($ordered | ForEach-Object { $_.Path + "`0" + $_.Hash + "`n" }) -join ''
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($manifest)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).ToUpperInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-CodexDevinGatewayFingerprint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$GatewayRoot,
        [Parameter(Mandatory)][string]$OAuthHelperPath,
        [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedFingerprint
    )
    return (Get-CodexDevinGatewayFingerprint -GatewayRoot $GatewayRoot -OAuthHelperPath $OAuthHelperPath) -ceq $ExpectedFingerprint.ToUpperInvariant()
}

function Test-CodexDevinCollapseGatewayReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Health,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ModelIds
    )

    if ($null -eq $Health -or $null -eq $ModelIds -or $ModelIds.Count -eq 0) { return $false }
    if ([string]$Health.status -cne 'ok') { return $false }
    $collapseProperty = $Health.PSObject.Properties['collapse_system_enabled']
    if ($null -eq $collapseProperty -or -not [bool]$collapseProperty.Value) { return $false }
    return ($ModelIds -ccontains 'glm-5-3-flash-low' -and $ModelIds -ccontains 'swe-2-medium')
}

function Test-CodexDevinCollapseRestoreSafe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][bool]$SwitchAttempted,
        [Parameter(Mandatory)][int]$ActiveDesktopProcessCount
    )

    return ($SwitchAttempted -and $ActiveDesktopProcessCount -eq 0)
}

function Get-CodexDevinCollapseDesktopWaitAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][bool]$DesktopStarted,
        [Parameter(Mandatory)][bool]$StartupTimedOut,
        [Parameter(Mandatory)][ValidateRange(0, 2147483647)][int]$ActiveDesktopProcessCount
    )

    if ($DesktopStarted) {
        if ($ActiveDesktopProcessCount -gt 0) { return 'WaitForClose' }
        return 'Restore'
    }
    if ($ActiveDesktopProcessCount -gt 0) { return 'DesktopStarted' }
    if ($StartupTimedOut) { return 'Restore' }
    return 'WaitForStart'
}

function Get-CodexDevinGatewayStartupFailureMessage {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StatusPath)

    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $StatusPath -ErrorAction Stop
        if ($item.Length -gt 4096) { return $null }
        $status = Get-Content -LiteralPath $StatusPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
    if ($null -eq $status) { return $null }
    $versionProperty = $status.PSObject.Properties['version']
    $codeProperty = $status.PSObject.Properties['code']
    if ($null -eq $versionProperty -or $null -eq $codeProperty) { return $null }
    if ([string]$versionProperty.Value -cne '1' -or $codeProperty.Value -isnot [string]) { return $null }

    switch -CaseSensitive ($codeProperty.Value) {
        'source_fingerprint_mismatch' { return 'Gateway startup rejected the stale reviewed clean-fork fingerprint; no gateway started and Codex config was not switched.' }
        'gateway_port_occupied' { return 'Gateway startup found port 38643 occupied; no process was stopped and Codex config was not switched.' }
        'callback_port_occupied' { return 'Gateway startup found callback port 59653 occupied; no process was stopped and Codex config was not switched.' }
        'gateway_already_healthy' { return 'A gateway already responds on port 38643, but its OAuth identity cannot be verified; no new gateway started and Codex config was not switched.' }
        'bun_not_found' { return 'Gateway startup could not find the expected Bun executable; Codex config was not switched.' }
        'dependencies_missing' { return 'Gateway startup found clean-fork dependencies missing; it did not install or change dependencies, and Codex config was not switched.' }
        'bridge_exit_nonzero' { return 'The clean-fork OAuth gateway process exited during startup; review the visible gateway window. Codex config was not switched.' }
        'gateway_startup_failed' { return 'Gateway startup failed; review the visible gateway window. Codex config was not switched.' }
        default { return $null }
    }
}

Export-ModuleMember -Function Get-CodexDevinCollapsePortListeners, Test-CodexDevinGatewayPortAvailable, Test-CodexDevinLoopbackPortFree, Resolve-CodexDevinGatewayRoot, Get-CodexDevinGatewayFingerprint, Test-CodexDevinGatewayFingerprint, Test-CodexDevinCollapseGatewayReady, Test-CodexDevinCollapseRestoreSafe, Get-CodexDevinCollapseDesktopWaitAction, Get-CodexDevinGatewayStartupFailureMessage
