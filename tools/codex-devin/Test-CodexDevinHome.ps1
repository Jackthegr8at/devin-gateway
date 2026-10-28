[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')

function Assert-Home([string]$Name, [bool]$Condition) {
    if (-not $Condition) { throw ('FAIL: ' + $Name) }
    Write-Host ('PASS: ' + $Name)
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-home-test-' + [guid]::NewGuid().ToString('N'))
$savedProfile = $env:USERPROFILE
$savedHome = $env:CODEX_HOME
$profilePath = Join-Path $testRoot 'profile'
$defaultHome = Join-Path $profilePath '.codex'
$alternateHome = Join-Path $testRoot 'alternate-home'
[void][IO.Directory]::CreateDirectory($defaultHome)
[void][IO.Directory]::CreateDirectory($alternateHome)
try {
    $env:USERPROFILE = $profilePath
    $env:CODEX_HOME = $null
    Assert-Home 'default home is derived from the current profile' ((Get-CodexDevinHome) -ceq $defaultHome)
    Assert-CodexDevinProfile
    $env:CODEX_HOME = $alternateHome
    Assert-Home 'an explicit absolute existing Codex home is honored' ((Get-CodexDevinHome) -ceq $alternateHome)
    Assert-CodexDevinProfile
    foreach ($invalid in @('relative-home', 'C:relative-home', '   ', (Join-Path $testRoot 'missing'), [IO.Path]::GetPathRoot($testRoot))) {
        $env:CODEX_HOME = $invalid
        $rejected = $false
        try { [void](Get-CodexDevinHome) } catch { $rejected = $true }
        Assert-Home 'invalid, missing, or root Codex homes fail closed' $rejected
    }
    $filePath = Join-Path $testRoot 'not-a-directory'
    [IO.File]::WriteAllText($filePath, 'synthetic fixture')
    $env:CODEX_HOME = $filePath
    $fileRejected = $false
    try { [void](Get-CodexDevinHome) } catch { $fileRejected = $true }
    Assert-Home 'a file cannot be selected as Codex home' $fileRejected
    [IO.File]::Delete($filePath)

    # Mock only the item lookup: no actual junction or active profile is modified.
    function Get-Item {
        param([string]$LiteralPath, [switch]$Force)
        [pscustomobject]@{ Attributes = [IO.FileAttributes]::ReparsePoint; Parent = $null }
    }
    $env:CODEX_HOME = $alternateHome
    $reparseRejected = $false
    try { [void](Get-CodexDevinHome) } catch { $reparseRejected = $_.Exception.Message -match 'reparse points' }
    Assert-Home 'profile/home reparse points fail closed' $reparseRejected
    Remove-Item Function:\Get-Item

    $env:USERPROFILE = $null
    $profileRejected = $false
    try { [void](Get-CodexDevinHome) } catch { $profileRejected = $true }
    Assert-Home 'missing profile fails closed' $profileRejected
} finally {
    Remove-Item Function:\Get-Item -ErrorAction SilentlyContinue
    $env:USERPROFILE = $savedProfile
    $env:CODEX_HOME = $savedHome
    [IO.Directory]::Delete($defaultHome, $false)
    [IO.Directory]::Delete($profilePath, $false)
    [IO.Directory]::Delete($alternateHome, $false)
    [IO.Directory]::Delete($testRoot, $false)
}
