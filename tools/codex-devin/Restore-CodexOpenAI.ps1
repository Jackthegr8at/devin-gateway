[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')

$codexHome = Get-CodexDevinHome
$backupRoot = Join-Path $codexHome 'devin-desktop-switch-backups'
$runDirectory = $null
$workerArchive = $null
$configArchive = $null

function Save-SwitchState([string]$Path, $State) {
    $json = ConvertTo-Json -InputObject $State -Depth 8
    Write-CodexDevinTextAtomically -Path $Path -Text ($json + "`r`n")
}

function Save-CurrentCopy([string]$Source, [string]$PreferredPath, [string]$ExpectedHash) {
    $sourceHash = Get-CodexDevinSha256 -Path $Source
    if ($sourceHash -eq $ExpectedHash) { return $null }

    $destination = $PreferredPath
    if ([IO.File]::Exists($destination)) {
        if ((Get-CodexDevinSha256 -Path $destination) -ne $sourceHash) {
            $destination = $PreferredPath + '.' + $sourceHash.Substring(0, 12)
        }
    }
    if (-not [IO.File]::Exists($destination)) {
        [IO.File]::Copy($Source, $destination, $false)
    }
    if ((Get-CodexDevinSha256 -Path $destination) -ne $sourceHash) { throw "Could not verify preservation copy: $destination" }
    return $destination
}

try {
    Write-Host '[1/6] Checking the user profile and recovery paths...'
    Assert-CodexDevinProfile
    Assert-CodexDevinNoReparsePoint -Path $codexHome
    Assert-CodexDevinNoReparsePoint -Path $backupRoot
    Assert-CodexDevinNoReparsePoint -Path (Join-Path $codexHome 'agents')
    if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) { throw "No switch backup directory exists at $backupRoot" }

    Write-Host '[2/6] Locating and validating the unresolved switch recovery record...'
    $unresolved = @()
    foreach ($directory in @(Get-ChildItem -LiteralPath $backupRoot -Directory)) {
        $candidateState = Join-Path $directory.FullName 'state.json'
        if (-not (Test-Path -LiteralPath $candidateState -PathType Leaf)) {
            throw "An incomplete backup has no state manifest: $($directory.FullName). Do not delete it; inspect its files before recovery."
        }
        try { $candidate = Get-Content -LiteralPath $candidateState -Raw | ConvertFrom-Json } catch {
            throw "A backup state file cannot be read: $candidateState"
        }
        if ($candidate.status -notin @('Restored', 'ResolvedBeforeSwitch')) {
            $unresolved += [pscustomobject]@{ Directory = $directory.FullName; StatePath = $candidateState; State = $candidate }
        }
    }
    if ($unresolved.Count -eq 0) {
        Write-Host 'No unresolved Devin switch run remains; nothing was changed.'
        return
    }
    if ($unresolved.Count -ne 1) {
        throw "Expected exactly one unresolved Devin switch, found $($unresolved.Count). No files were changed."
    }

    $runDirectory = $unresolved[0].Directory
    Assert-CodexDevinNoReparsePoint -Path $runDirectory
    $statePath = $unresolved[0].StatePath
    $state = $unresolved[0].State
    $configPath = Join-Path $codexHome 'config.toml'
    $agentPath = Join-Path $codexHome 'agents\swe_worker.toml'
    $configBackup = Join-Path $runDirectory 'config.toml.original'
    $workerBackup = Join-Path $runDirectory 'swe_worker.toml.original'
    Assert-CodexDevinNoReparsePoint -Path $configPath
    Assert-CodexDevinNoReparsePoint -Path $agentPath

    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$state.configPath), [IO.Path]::GetFullPath($configPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The backup manifest targets an unexpected Codex config path; no files were changed.'
    }
    if ($state.status -in @('Preparing', 'Prepared', 'CatalogReady')) {
        Write-Host '[3/6] Archiving current files without changing the active config or worker...'
        if ([string]$state.configOriginalSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
            throw 'The original config hash in the recovery manifest is invalid; no active files were changed.'
        }
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            throw 'The active config is missing; cannot archive its current bytes, so the pre-switch run remains unresolved.'
        }
        $configItem = Get-Item -LiteralPath $configPath -Force
        if ($configItem.PSIsContainer -or ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The active config is a directory or reparse point; refusing to resolve this run.'
        }

        $configSnapshot = Save-CodexDevinPreservedSnapshot -SourcePath $configPath -SnapshotDirectory $runDirectory -Label 'config.toml'
        $workerSnapshot = $null
        $workerExistedAtResolution = Test-Path -LiteralPath $agentPath
        if ($workerExistedAtResolution) {
            $workerItem = Get-Item -LiteralPath $agentPath -Force
            if ($workerItem.PSIsContainer -or ($workerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'The active worker is a directory or reparse point; refusing to resolve this run.'
            }
            $workerSnapshot = Save-CodexDevinPreservedSnapshot -SourcePath $agentPath -SnapshotDirectory $runDirectory -Label 'swe_worker.toml'
        }

        if ((Get-CodexDevinSha256 -Path $configPath) -ne $configSnapshot.Sha256) {
            throw 'The active config changed after its preservation snapshot; run remains unresolved and no active files were changed.'
        }
        $workerExistsNow = Test-Path -LiteralPath $agentPath
        if ($workerExistsNow -ne $workerExistedAtResolution) {
            throw 'The active worker changed after the preservation snapshot; run remains unresolved and no active files were changed.'
        }
        if ($workerSnapshot -and (Get-CodexDevinSha256 -Path $agentPath) -ne $workerSnapshot.Sha256) {
            throw 'The active worker changed after its preservation snapshot; run remains unresolved and no active files were changed.'
        }

        $state.status = 'ResolvedBeforeSwitch'
        $state | Add-Member -NotePropertyName resolvedBeforeSwitchUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
        $state | Add-Member -NotePropertyName preservedConfigPath -NotePropertyValue $configSnapshot.Path -Force
        $state | Add-Member -NotePropertyName preservedConfigSha256 -NotePropertyValue $configSnapshot.Sha256 -Force
        $state | Add-Member -NotePropertyName preservedWorkerExisted -NotePropertyValue ([bool]$workerExistedAtResolution) -Force
        $state | Add-Member -NotePropertyName preservedWorkerPath -NotePropertyValue $(if ($workerSnapshot) { $workerSnapshot.Path } else { $null }) -Force
        $state | Add-Member -NotePropertyName preservedWorkerSha256 -NotePropertyValue $(if ($workerSnapshot) { $workerSnapshot.Sha256 } else { $null }) -Force
        Save-SwitchState -Path $statePath -State $state
        Write-Host 'The pre-switch run is resolved. Current config/worker bytes were left active; any present worker was also preserved byte-for-byte.'
        Write-Host "Preserved config SHA-256: $($configSnapshot.Sha256)"
        Write-Host "Recovery directory: $runDirectory"
        Write-Host 'Any dormant model catalog copy and Codex history were left untouched.'
        return
    }

    if ($state.status -notin @('WorkerInstalling', 'WorkerInstalled', 'Enabled', 'Restoring')) {
        throw "Unrecognized switch state '$($state.status)'; no active files were changed."
    }
    Write-Host '[3/6] Checking that Codex Desktop/app-server is closed before restoring active files...'
    Assert-CodexDevinStopped
    Write-Host '[4/6] Verifying original config and worker backup hashes...'
    if (-not (Test-Path -LiteralPath $configBackup -PathType Leaf) -or (Get-CodexDevinSha256 -Path $configBackup) -ne $state.configOriginalSha256) {
        throw "The exact original config backup is missing or fails its recorded SHA-256: $configBackup"
    }
    if ([bool]$state.workerExisted) {
        if (-not (Test-Path -LiteralPath $workerBackup -PathType Leaf) -or (Get-CodexDevinSha256 -Path $workerBackup) -ne $state.workerOriginalSha256) {
            throw "The original worker backup is missing or fails its recorded SHA-256: $workerBackup"
        }
    }

    Write-Host '[5/6] Preserving Devin-mode edits if needed and restoring original worker/config bytes...'
    $state.status = 'Restoring'
    Save-SwitchState -Path $statePath -State $state

    if (Test-Path -LiteralPath $agentPath) {
        $agentItem = Get-Item -LiteralPath $agentPath -Force
        if ($agentItem.PSIsContainer -or ($agentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The worker target became a directory or reparse point; refusing to alter it.'
        }
    }

    if ([bool]$state.workerExisted) {
        if (Test-Path -LiteralPath $agentPath -PathType Leaf) {
            $workerArchive = Save-CurrentCopy -Source $agentPath -PreferredPath (Join-Path $runDirectory 'swe_worker.toml.devin-current') -ExpectedHash $state.workerOriginalSha256
        }
        $workerBytes = [IO.File]::ReadAllBytes($workerBackup)
        Write-CodexDevinBytesAtomically -Path $agentPath -Bytes $workerBytes
        if ((Get-CodexDevinSha256 -Path $agentPath) -ne $state.workerOriginalSha256) { throw 'Restored worker hash did not match the original.' }
    } elseif (Test-Path -LiteralPath $agentPath -PathType Leaf) {
        $workerHashNow = Get-CodexDevinSha256 -Path $agentPath
        if ($workerHashNow -ne $state.workerManagedSha256) {
            $workerArchive = Save-CurrentCopy -Source $agentPath -PreferredPath (Join-Path $runDirectory 'swe_worker.toml.devin-current') -ExpectedHash $state.workerManagedSha256
        }
        [IO.File]::Delete($agentPath)
    }
    Save-SwitchState -Path $statePath -State $state

    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $configItem = Get-Item -LiteralPath $configPath -Force
        if ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The config target became a reparse point; refusing to alter it.' }
        $configArchive = Save-CurrentCopy -Source $configPath -PreferredPath (Join-Path $runDirectory 'config.toml.devin-current') -ExpectedHash $state.configOriginalSha256
    }
    $originalConfigBytes = [IO.File]::ReadAllBytes($configBackup)
    Write-CodexDevinBytesAtomically -Path $configPath -Bytes $originalConfigBytes
    Write-Host '[6/6] Verifying restored hashes and recording completion...'
    if ((Get-CodexDevinSha256 -Path $configPath) -ne $state.configOriginalSha256) { throw 'Restored config hash did not match the original.' }

    $state.status = 'Restored'
    Save-SwitchState -Path $statePath -State $state

    Write-Host 'Normal OpenAI Codex configuration restored byte-for-byte.'
    Write-Host "Verified config SHA-256: $($state.configOriginalSha256)"
    if ($workerArchive) { Write-Host "A changed worker file was preserved at: $workerArchive" }
    if ($configArchive) { Write-Host "The Devin-mode config was preserved at: $configArchive" }
    Write-Host "Recovery records and original backups remain at: $runDirectory"
    Write-Host 'The dormant model catalog and Codex history were left untouched.'
} catch {
    [Console]::Error.WriteLine('Restore failed: ' + $_.Exception.Message)
    if ($runDirectory) { [Console]::Error.WriteLine("Recovery directory: $runDirectory") }
    [Console]::Error.WriteLine('No Codex process was stopped. Close Desktop and rerun Restore-CodexOpenAI.ps1 to retry if restoration was interrupted.')
    throw 'Restore did not complete. Review the message above and retry only after resolving the stated issue.'
}
