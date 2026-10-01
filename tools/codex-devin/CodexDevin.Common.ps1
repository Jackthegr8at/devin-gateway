Set-StrictMode -Version Latest

function Get-CodexDevinHome {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw 'USERPROFILE must identify the current Windows profile.'
    }
    $profilePath = $env:USERPROFILE
    if (-not [IO.Path]::IsPathRooted($profilePath) -or $profilePath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
        throw 'USERPROFILE must be a fully qualified directory path.'
    }
    try { $profilePath = [IO.Path]::GetFullPath($profilePath) } catch {
        throw 'USERPROFILE is not a valid directory path.'
    }
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
        throw 'The current Windows profile directory does not exist.'
    }

    $homePath = Join-Path $profilePath '.codex'
    if ($null -ne $env:CODEX_HOME) {
        if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME) -or $env:CODEX_HOME -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
            throw 'CODEX_HOME must be a fully qualified directory path when explicitly set.'
        }
        $homePath = $env:CODEX_HOME
    }
    try { $homePath = [IO.Path]::GetFullPath($homePath).TrimEnd([char[]]@('\', '/')) } catch {
        throw 'CODEX_HOME is not a valid directory path.'
    }
    $rootPath = [IO.Path]::GetPathRoot($homePath).TrimEnd([char[]]@('\', '/'))
    if ($homePath -ceq $rootPath -or -not (Test-Path -LiteralPath $homePath -PathType Container)) {
        throw 'The Codex home must be an existing directory, not a filesystem root.'
    }
    foreach ($candidate in @($profilePath, $homePath)) {
        $current = Get-Item -LiteralPath $candidate -Force
        while ($null -ne $current) {
            if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'The Windows profile and Codex home must not pass through reparse points.'
            }
            $current = $current.Parent
        }
    }
    return $homePath
}

function Assert-CodexDevinProfile {
    [void](Get-CodexDevinHome)
}

function Assert-CodexDevinNoReparsePoint([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to write through a reparse point: $Path"
        }
    }
}

# Only the exact bundled runtime image in this user's Desktop install is a blocker.
# Sandbox, command-runner, code-mode, CUA, and unrelated node/bun helpers are not.
function Get-CodexDevinBlockingProcesses([object[]]$Processes) {
    $installRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex')).TrimEnd('\') + '\'
    $blocked = @(
        foreach ($process in $Processes) {
            if (-not [string]::Equals([string]$process.ProcessName, 'codex', [StringComparison]::OrdinalIgnoreCase)) { continue }
            $path = [string]$process.Path
            if ([string]::IsNullOrWhiteSpace($path)) {
                throw "Cannot identify the executable path for Codex process PID $($process.Id); close it normally and retry."
            }
            try { $fullPath = [IO.Path]::GetFullPath($path) } catch {
                throw "Cannot verify the executable path for Codex process PID $($process.Id); close it normally and retry."
            }
            $underDesktopInstall = $fullPath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
            $isCodexRuntimeImage = [string]::Equals([IO.Path]::GetFileName($fullPath), 'codex.exe', [StringComparison]::OrdinalIgnoreCase)
            if ($underDesktopInstall -and $isCodexRuntimeImage) {
                [pscustomobject]@{ ProcessId = $process.Id; Name = $process.ProcessName }
            }
        }
    )
    return $blocked
}

function Assert-CodexDevinStopped {
    Write-Host 'Inspecting active Codex Desktop/app-server processes (helpers and sandbox service are ignored)...'
    try {
        $processes = @(Get-Process -ErrorAction Stop)
    } catch {
        throw 'Cannot reliably inspect running processes. Close Codex Desktop and retry; no process was stopped.'
    }

    $blocked = @(Get-CodexDevinBlockingProcesses -Processes $processes)

    if ($blocked.Count -gt 0) {
        $summary = ($blocked | ForEach-Object { '{0} (PID {1})' -f $_.Name, $_.ProcessId }) -join ', '
        throw "The Codex Desktop bundled runtime/app-server is still running: $summary. Close Codex Desktop normally and retry; this script never kills processes."
    }
}

function Get-CodexDevinGatewayHealth {
    param([string]$Uri = 'http://127.0.0.1:38643/health')

    try {
        $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 3 -ErrorAction Stop
        if ($response -is [string]) {
            $healthy = [string]::Equals($response.Trim(), 'ok', [StringComparison]::OrdinalIgnoreCase)
        } else {
            $status = $response.PSObject.Properties['status']
            $healthy = $null -ne $status -and [string]::Equals([string]$status.Value, 'ok', [StringComparison]::OrdinalIgnoreCase)
        }
        return [pscustomobject]@{ Healthy = [bool]$healthy }
    } catch {
        return [pscustomobject]@{ Healthy = $false }
    }
}

function Assert-CodexDevinCatalogModels {
    param(
        [string]$JsonText,
        [string[]]$RequiredSlugs
    )

    try {
        $catalog = ConvertFrom-Json -InputObject $JsonText -ErrorAction Stop
    } catch {
        throw 'The validated model catalog is not valid JSON; refusing to copy it.'
    }

    $modelsProperty = $catalog.PSObject.Properties['models']
    if ($null -eq $modelsProperty -or $modelsProperty.Value -isnot [array]) {
        throw 'The validated model catalog must contain a top-level models array.'
    }

    $slugs = @(
        foreach ($model in $modelsProperty.Value) {
            if ($null -eq $model) { continue }
            $slugProperty = $model.PSObject.Properties['slug']
            if ($null -ne $slugProperty -and $slugProperty.Value -is [string]) {
                [string]$slugProperty.Value
            }
        }
    )

    foreach ($requiredSlug in $RequiredSlugs) {
        if ($slugs -cnotcontains $requiredSlug) {
            throw "The validated catalog does not contain required model slug '$requiredSlug'."
        }
    }
}

function Get-CodexDevinSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-CodexDevinBytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($Bytes)
        return ([BitConverter]::ToString($digest).Replace('-', '')).ToUpperInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Save-CodexDevinPreservedSnapshot {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$SnapshotDirectory,
        [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$Label
    )

    Assert-CodexDevinNoReparsePoint -Path $SourcePath
    Assert-CodexDevinNoReparsePoint -Path $SnapshotDirectory
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Cannot preserve a missing file: $SourcePath"
    }
    if (-not (Test-Path -LiteralPath $SnapshotDirectory -PathType Container)) {
        throw "Snapshot directory does not exist: $SnapshotDirectory"
    }

    $sourceItem = Get-Item -LiteralPath $SourcePath -Force
    if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to snapshot a reparse point: $SourcePath"
    }

    $sourceHash = Get-CodexDevinSha256 -Path $SourcePath
    $snapshotPath = Join-Path $SnapshotDirectory ($Label + '.active-preserved-' + [guid]::NewGuid().ToString('N') + '.bak')
    [IO.File]::Copy($SourcePath, $snapshotPath, $false)
    $snapshotHash = Get-CodexDevinSha256 -Path $snapshotPath
    $sourceHashAfterCopy = Get-CodexDevinSha256 -Path $SourcePath
    if ($snapshotHash -ne $sourceHash -or $sourceHashAfterCopy -ne $sourceHash) {
        throw "Preservation snapshot verification failed because the source changed or the copy differed: $snapshotPath"
    }

    return [pscustomobject]@{ Path = $snapshotPath; Sha256 = $snapshotHash }
}

function Write-CodexDevinBytesAtomically([string]$Path, [byte[]]$Bytes) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $replaceBackup = $temporary + '.replace-backup'
    $replaceCompleted = $false
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporary, $Path, $replaceBackup)
            $replaceCompleted = $true
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ($replaceCompleted -and [IO.File]::Exists($replaceBackup)) {
            try { [IO.File]::Delete($replaceBackup) } catch { }
        }
    }
}

function Write-CodexDevinTextAtomically([string]$Path, [string]$Text) {
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes($Text)
    Write-CodexDevinBytesAtomically -Path $Path -Bytes $bytes
}

function Get-CodexDevinNewline([string]$Text) {
    if ($Text.Contains("`r`n")) { return "`r`n" }
    if ($Text.Contains("`n")) { return "`n" }
    if ($Text.Contains("`r")) { return "`r" }
    return "`r`n"
}

function Get-CodexDevinTomlHeaders([string]$Text) {
    return [regex]::Matches($Text, '(?m)^[ \t]*\[(?!\[)(?<name>[^\]\r\n]+)\][ \t]*(?:#.*)?(?=\r?$)')
}

function Get-CodexDevinTomlSpan([string]$Text, [string]$Section) {
    $headers = @(Get-CodexDevinTomlHeaders -Text $Text)
    if ([string]::IsNullOrEmpty($Section)) {
        $end = if ($headers.Count -gt 0) { $headers[0].Index } else { $Text.Length }
        return [pscustomobject]@{ Found = $true; Start = 0; End = $end }
    }

    $matches = @($headers | Where-Object { [string]::Equals($_.Groups['name'].Value.Trim(), $Section, [StringComparison]::Ordinal) })
    if ($matches.Count -gt 1) { throw "Duplicate TOML section [$Section]; refusing to edit it." }
    if ($matches.Count -eq 0) { return [pscustomobject]@{ Found = $false; Start = $Text.Length; End = $Text.Length } }

    $header = $matches[0]
    $next = @($headers | Where-Object { $_.Index -gt $header.Index } | Sort-Object Index | Select-Object -First 1)
    $end = if ($next.Count -gt 0) { $next[0].Index } else { $Text.Length }
    return [pscustomobject]@{ Found = $true; Start = $header.Index + $header.Length; End = $end }
}

function Get-CodexDevinTomlKeyLine([string]$Text, [string]$Section, [string]$Key) {
    $span = Get-CodexDevinTomlSpan -Text $Text -Section $Section
    if (-not $span.Found) { return $null }
    $segment = $Text.Substring($span.Start, $span.End - $span.Start)
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Key) + '[ \t]*=[^\r\n]*(?:\r\n|\n|\r|$)'
    $matches = [regex]::Matches($segment, $pattern)
    if ($matches.Count -gt 1) { throw "Duplicate TOML key '$Key' in [$Section]; refusing to edit it." }
    if ($matches.Count -eq 0) { return $null }
    return $matches[0].Value
}

function Set-CodexDevinTomlKey([string]$Text, [string]$Section, [string]$Key, [string]$Value) {
    $span = Get-CodexDevinTomlSpan -Text $Text -Section $Section
    $newline = Get-CodexDevinNewline -Text $Text
    if (-not $span.Found) {
        if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n") -and -not $Text.EndsWith("`r")) { $Text += $newline }
        $Text += $newline + "[$Section]" + $newline
        $span = Get-CodexDevinTomlSpan -Text $Text -Section $Section
    }

    $segment = $Text.Substring($span.Start, $span.End - $span.Start)
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Key) + '[ \t]*=[^\r\n]*(?:\r\n|\n|\r|$)'
    $matches = [regex]::Matches($segment, $pattern)
    if ($matches.Count -gt 1) { throw "Duplicate TOML key '$Key' in [$Section]; refusing to edit it." }
    $replacement = "$Key = $Value$newline"
    if ($matches.Count -eq 1) {
        $match = $matches[0]
        return $Text.Substring(0, $span.Start + $match.Index) + $replacement + $Text.Substring($span.Start + $match.Index + $match.Length)
    }

    if ($span.End -gt $span.Start -and -not $Text.Substring(0, $span.End).EndsWith("`n") -and -not $Text.Substring(0, $span.End).EndsWith("`r")) {
        $replacement = $newline + $replacement
    }
    return $Text.Substring(0, $span.End) + $replacement + $Text.Substring($span.End)
}

function Remove-CodexDevinTomlKey([string]$Text, [string]$Section, [string]$Key) {
    $span = Get-CodexDevinTomlSpan -Text $Text -Section $Section
    if (-not $span.Found) { return $Text }
    $segment = $Text.Substring($span.Start, $span.End - $span.Start)
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Key) + '[ \t]*=[^\r\n]*(?:\r\n|\n|\r|$)'
    $matches = [regex]::Matches($segment, $pattern)
    if ($matches.Count -gt 1) { throw "Duplicate TOML key '$Key' in [$Section]; refusing to edit it." }
    if ($matches.Count -eq 0) { return $Text }
    $match = $matches[0]
    return $Text.Substring(0, $span.Start + $match.Index) + $Text.Substring($span.Start + $match.Index + $match.Length)
}

function ConvertTo-CodexDevinTomlString([string]$Value) {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Get-CodexDevinWorkerBytes {
    $newline = "`r`n"
    $lines = @(
        'model = "swe-2-medium"'
        'model_reasoning_effort = "medium"'
        ''
        'developer_instructions = """'
        'Explore the assigned repository and complete only the scoped subtask. For implementation work, make focused changes and run relevant tests. Do not change permissions, sandbox settings, or unrelated files. Report changes, checks, and blockers concisely to the parent.'
        '"""'
        ''
    )
    $text = ($lines -join $newline)
    return [Text.UTF8Encoding]::new($false).GetBytes($text)
}
