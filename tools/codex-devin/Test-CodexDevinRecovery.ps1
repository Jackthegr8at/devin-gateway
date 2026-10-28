[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')

function Assert-Equal([string]$Name, $Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "FAIL: $Name`nExpected: $Expected`nActual:   $Actual" }
    Write-Host "PASS: $Name"
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-devin-recovery-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)

try {
    $configPath = Join-Path $testRoot 'config.toml'
    $firstBytes = [byte[]](0, 1, 2, 10, 13, 127, 255)
    [IO.File]::WriteAllBytes($configPath, $firstBytes)
    $firstSourceHash = Get-CodexDevinSha256 -Path $configPath

    $firstSnapshot = Save-CodexDevinPreservedSnapshot -SourcePath $configPath -SnapshotDirectory $testRoot -Label 'config.toml'
    Assert-Equal 'config snapshot hash matches source' $firstSnapshot.Sha256 $firstSourceHash
    Assert-Equal 'config snapshot bytes match source' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($firstSnapshot.Path))) ([Convert]::ToBase64String($firstBytes))
    Assert-Equal 'config source remains unchanged' (Get-CodexDevinSha256 -Path $configPath) $firstSourceHash

    $secondBytes = [byte[]](9, 8, 7, 0, 255)
    [IO.File]::WriteAllBytes($configPath, $secondBytes)
    $secondSourceHash = Get-CodexDevinSha256 -Path $configPath
    $secondSnapshot = Save-CodexDevinPreservedSnapshot -SourcePath $configPath -SnapshotDirectory $testRoot -Label 'config.toml'
    Assert-Equal 'repeated snapshots use distinct paths' ($firstSnapshot.Path -ne $secondSnapshot.Path) $true
    Assert-Equal 'earlier snapshot is not overwritten' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($firstSnapshot.Path))) ([Convert]::ToBase64String($firstBytes))
    Assert-Equal 'new snapshot preserves latest config bytes' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($secondSnapshot.Path))) ([Convert]::ToBase64String($secondBytes))
    Assert-Equal 'latest config remains unchanged' (Get-CodexDevinSha256 -Path $configPath) $secondSourceHash
    Write-CodexDevinBytesAtomically -Path $configPath -Bytes ([IO.File]::ReadAllBytes($firstSnapshot.Path))
    Assert-Equal 'config restore writes the exact original bytes atomically' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath))) ([Convert]::ToBase64String($firstBytes))
    Assert-Equal 'config restore hash matches the original baseline' (Get-CodexDevinSha256 -Path $configPath) $firstSourceHash

    $workerPath = Join-Path $testRoot 'swe_worker.toml'
    $workerBytes = [Text.Encoding]::UTF8.GetBytes("model = `"swe-2-medium`"`r`n")
    [IO.File]::WriteAllBytes($workerPath, $workerBytes)
    $workerHash = Get-CodexDevinSha256 -Path $workerPath
    $workerSnapshot = Save-CodexDevinPreservedSnapshot -SourcePath $workerPath -SnapshotDirectory $testRoot -Label 'swe_worker.toml'
    Assert-Equal 'worker snapshot hash matches source' $workerSnapshot.Sha256 $workerHash
    Assert-Equal 'worker source remains unchanged' (Get-CodexDevinSha256 -Path $workerPath) $workerHash
    [IO.File]::WriteAllText($workerPath, 'temporary Devin worker state')
    Write-CodexDevinBytesAtomically -Path $workerPath -Bytes ([IO.File]::ReadAllBytes($workerSnapshot.Path))
    Assert-Equal 'pre-existing worker restore writes the exact original bytes atomically' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($workerPath))) ([Convert]::ToBase64String($workerBytes))
    Assert-Equal 'pre-existing worker restore hash matches the original baseline' (Get-CodexDevinSha256 -Path $workerPath) $workerHash
} finally {
    foreach ($item in @(Get-ChildItem -LiteralPath $testRoot -File -Force -ErrorAction SilentlyContinue)) {
        [IO.File]::Delete($item.FullName)
    }
    [IO.Directory]::Delete($testRoot, $false)
}
