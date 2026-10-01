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

function Resolve-CodexDevinGatewayTarget {
    [CmdletBinding()]
    param([string]$GatewayUrl = 'http://127.0.0.1:38643')

    $uri = $null
    if (-not [Uri]::TryCreate($GatewayUrl, [UriKind]::Absolute, [ref]$uri)) {
        throw 'GatewayUrl must be an absolute HTTP gateway root URL.'
    }
    if (
        $uri.Scheme -cne 'http' -or
        $uri.AbsolutePath -cne '/' -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)
    ) {
        throw 'GatewayUrl must be an HTTP origin with no path, credentials, query, or fragment.'
    }

    $isLoopback = [bool]$uri.IsLoopback
    if ($isLoopback) {
        if ($uri.Port -ne 38643) {
            throw 'The local guarded gateway workflow supports only loopback port 38643.'
        }
        $rootUrl = 'http://127.0.0.1:38643'
    } else {
        $rootUrl = $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
    }

    return [pscustomobject]@{
        RootUrl = $rootUrl
        HealthUri = "$rootUrl/health"
        ModelsUri = "$rootUrl/v1/models"
        BaseUrl = "$rootUrl/v1"
        IsRemote = (-not $isLoopback)
    }
}

function Test-CodexDevinRemoteGatewayHealth {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Health)

    if ($null -eq $Health) { return $false }
    $statusProperty = $Health.PSObject.Properties['status']
    $collapseProperty = $Health.PSObject.Properties['collapse_system_enabled']
    if ($null -eq $statusProperty -or $null -eq $collapseProperty) { return $false }
    if ([string]$statusProperty.Value -cne 'ok') { return $false }
    return ($collapseProperty.Value -is [bool] -and [bool]$collapseProperty.Value)
}

function Get-CodexDevinFallbackTokenState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Health)

    if ($null -eq $Health) { return 'unknown' }
    $property = $Health.PSObject.Properties['fallback_token']
    if ($null -eq $property) { return 'unknown' }
    if ([string]$property.Value -ceq 'set') { return 'set' }
    if ([string]$property.Value -ceq 'not_set') { return 'not_set' }
    return 'unknown'
}

function Test-CodexDevinSshTarget {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][AllowEmptyString()][string]$SshTarget)

    if ([string]::IsNullOrWhiteSpace($SshTarget)) { return $false }
    return ($SshTarget -cmatch '^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$')
}

function ConvertTo-CodexDevinRemoteShellPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if ($Path -notmatch '^/[^\x00\r\n]*$' -or $Path -ceq '/') {
        throw 'RemoteGatewayDirectory must be an absolute POSIX directory path without line breaks.'
    }
    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $escape = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    return $singleQuote + $Path.Replace($singleQuote, $escape) + $singleQuote
}

function New-CodexDevinRemoteComposeCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Login', 'Restart')][string]$Action,
        [Parameter(Mandatory)][string]$RemoteGatewayDirectory
    )

    $quotedDirectory = ConvertTo-CodexDevinRemoteShellPath -Path $RemoteGatewayDirectory
    if ($Action -ceq 'Login') { return "cd $quotedDirectory && docker compose run --rm devin-login" }
    return "cd $quotedDirectory && docker compose up -d --force-recreate devin-gateway"
}

function Invoke-CodexDevinRemoteAuthentication {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$InitialHealth,
        [Parameter(Mandatory)][scriptblock]$HealthProbe,
        [Parameter(Mandatory)][scriptblock]$InteractiveLogin,
        [Parameter(Mandatory)][scriptblock]$RestartGateway,
        [string]$SshTarget,
        [string]$RemoteGatewayDirectory,
        [ValidateRange(1, 120)][int]$MaxHealthChecks = 36,
        [ValidateRange(0, 60)][int]$PollIntervalSeconds = 5
    )

    if (-not (Test-CodexDevinRemoteGatewayHealth -Health $InitialHealth)) {
        throw 'Remote gateway health is not ready; authentication setup was not started.'
    }

    $state = Get-CodexDevinFallbackTokenState -Health $InitialHealth
    if ($state -ceq 'set') {
        return [pscustomobject]@{ FallbackToken = 'set'; LoginPerformed = $false; GatewayRecreated = $false }
    }
    if ($state -cne 'not_set') {
        throw 'Remote /health did not provide a recognized fallback_token state; refusing to switch Codex configuration.'
    }
    if ([string]::IsNullOrWhiteSpace($SshTarget) -or -not (Test-CodexDevinSshTarget -SshTarget $SshTarget)) {
        throw 'A valid RemoteSshTarget is required when devhub reports fallback_token=not_set.'
    }
    if ([string]::IsNullOrWhiteSpace($RemoteGatewayDirectory)) {
        throw 'RemoteGatewayDirectory is required when devhub reports fallback_token=not_set.'
    }
    $null = ConvertTo-CodexDevinRemoteShellPath -Path $RemoteGatewayDirectory

    if (-not (& $InteractiveLogin $SshTarget $RemoteGatewayDirectory)) {
        throw 'Interactive devhub Devin login failed; the gateway was not restarted and Codex configuration was not switched.'
    }
    if (-not (& $RestartGateway $SshTarget $RemoteGatewayDirectory)) {
        throw 'The devhub gateway restart failed after login; Codex configuration was not switched.'
    }

    for ($attempt = 0; $attempt -lt $MaxHealthChecks; $attempt++) {
        if ($attempt -gt 0 -and $PollIntervalSeconds -gt 0) { Start-Sleep -Seconds $PollIntervalSeconds }
        $health = $null
        try { $health = & $HealthProbe } catch { }
        if (-not (Test-CodexDevinRemoteGatewayHealth -Health $health)) { continue }
        if ((Get-CodexDevinFallbackTokenState -Health $health) -ceq 'set') {
            return [pscustomobject]@{ FallbackToken = 'set'; LoginPerformed = $true; GatewayRecreated = $true }
        }
    }

    throw 'Devhub login/restart finished, but bounded /health checks did not confirm fallback_token=set; Codex configuration was not switched.'
}

function Invoke-CodexDevinGatewayPreflight {
    [CmdletBinding()]
    param(
        [string]$GatewayUrl = 'http://127.0.0.1:38643',
        [Parameter(Mandatory)][scriptblock]$RemoteHealthProbe,
        [Parameter(Mandatory)][scriptblock]$LocalGatewayStartup
    )

    $target = Resolve-CodexDevinGatewayTarget -GatewayUrl $GatewayUrl
    if ($target.IsRemote) {
        $health = $null
        try { $health = & $RemoteHealthProbe $target.HealthUri } catch { }
        if (-not (Test-CodexDevinRemoteGatewayHealth -Health $health)) {
            throw 'Remote gateway /health preflight failed; status=ok and collapse_system_enabled=true are required. Codex config was not switched and localhost was not started.'
        }
        return [pscustomobject]@{ Target = $target; LocalStartup = $null; RemoteHealth = $health }
    }

    $localStartup = & $LocalGatewayStartup $target
    return [pscustomobject]@{ Target = $target; LocalStartup = $localStartup; RemoteHealth = $null }
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

Export-ModuleMember -Function Get-CodexDevinCollapsePortListeners, Test-CodexDevinGatewayPortAvailable, Resolve-CodexDevinGatewayTarget, Test-CodexDevinRemoteGatewayHealth, Get-CodexDevinFallbackTokenState, Test-CodexDevinSshTarget, ConvertTo-CodexDevinRemoteShellPath, New-CodexDevinRemoteComposeCommand, Invoke-CodexDevinRemoteAuthentication, Invoke-CodexDevinGatewayPreflight, Test-CodexDevinLoopbackPortFree, Resolve-CodexDevinGatewayRoot, Get-CodexDevinGatewayFingerprint, Test-CodexDevinGatewayFingerprint, Test-CodexDevinCollapseGatewayReady, Test-CodexDevinCollapseRestoreSafe, Get-CodexDevinCollapseDesktopWaitAction, Get-CodexDevinGatewayStartupFailureMessage
