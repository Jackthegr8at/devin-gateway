[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')
# Script-scoped process inventory mock; production guards remain unchanged.
function Get-Process { [CmdletBinding()] param() return @() }
$originalHome = $env:CODEX_HOME
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('codex-recovery-workflow-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($case in @('Preparing', 'ActiveAbsentWorker', 'ActiveExistingWorker', 'CorruptBackup')) {
        $fixtureHome = Join-Path $fixture $case
        $agents = Join-Path $fixtureHome 'agents'
        $run = Join-Path $fixtureHome 'devin-desktop-switch-backups\synthetic-run'
        [void][IO.Directory]::CreateDirectory($agents)
        [void][IO.Directory]::CreateDirectory($run)
        $env:CODEX_HOME = $fixtureHome
        $config = Join-Path $fixtureHome 'config.toml'
        $worker = Join-Path $agents 'swe_worker.toml'
        $bytes = [Text.Encoding]::UTF8.GetBytes("model = `"synthetic-original`"`r`n")
        $workerBytes = [Text.Encoding]::UTF8.GetBytes('synthetic-original-worker')
        $backup = Join-Path $run 'config.toml.original'
        [IO.File]::WriteAllBytes($backup, $bytes)
        $existing = $case -ceq 'ActiveExistingWorker'
        if ($existing) { [IO.File]::WriteAllBytes((Join-Path $run 'swe_worker.toml.original'), $workerBytes) }
        [IO.File]::WriteAllText($config, 'synthetic-current-config')
        [IO.File]::WriteAllBytes($worker, (Get-CodexDevinWorkerBytes))
        $state = [pscustomobject]@{
            status = $(if ($case -ceq 'Preparing') { 'Preparing' } else { 'Enabled' })
            configPath = $config
            configOriginalSha256 = Get-CodexDevinBytesSha256 $bytes
            workerExisted = $existing
            workerOriginalSha256 = Get-CodexDevinBytesSha256 $workerBytes
            workerManagedSha256 = Get-CodexDevinSha256 $worker
        }
        $statePath = Join-Path $run 'state.json'
        Write-CodexDevinTextAtomically $statePath ($state | ConvertTo-Json)
        $before = Get-CodexDevinSha256 $config
        if ($case -ceq 'CorruptBackup') { [IO.File]::WriteAllText($backup, 'corrupted') }
        $failed = $false
        try { & (Join-Path $PSScriptRoot 'Restore-CodexOpenAI.ps1') } catch { $failed = $true }
        $after = Get-CodexDevinSha256 $config
        if ($case -ceq 'CorruptBackup') {
            if (-not $failed -or $before -ne $after) { throw 'Corrupt backup did not fail closed.' }
        } elseif ($case -ceq 'Preparing') {
            if ($failed -or $before -ne $after -or (Get-Content $statePath -Raw | ConvertFrom-Json).status -cne 'ResolvedBeforeSwitch') { throw 'Preparing recovery changed active bytes.' }
        } else {
            if ($failed -or $after -ne $state.configOriginalSha256) { throw 'Config was not restored byte-for-byte.' }
            if ($existing) {
                if ((Get-CodexDevinSha256 $worker) -ne $state.workerOriginalSha256) { throw 'Original worker was not restored.' }
            } elseif ([IO.File]::Exists($worker)) { throw 'Temporary worker was not removed.' }
        }
        Write-Host "PASS: isolated restore workflow $case"
    }
} finally {
    if ($null -eq $originalHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $originalHome }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\codex-recovery-workflow-'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup target.' }
    if ([IO.Directory]::Exists($resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
