[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'CodexDevin.CollapseTest.Guards.psm1') -Force

$script:passed = 0
function Assert-GatewayFingerprint([string]$Name, [bool]$Condition) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:passed++
    Write-Host "PASS: $Name"
}

$gatewayRoot = Resolve-CodexDevinGatewayRoot -ToolDirectory $PSScriptRoot
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Assert-GatewayFingerprint 'launcher resolves the repository root relative to its copied tools directory' ([string]::Equals($gatewayRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase))

$oauthHelperPath = Join-Path $PSScriptRoot 'DevinOAuthBridge.ts'
$launcherPath = Join-Path $PSScriptRoot 'Start-DevinGateway.ps1'
$launcherText = Get-Content -LiteralPath $launcherPath -Raw
$pinMatch = [regex]::Match($launcherText, "\`$reviewedSourceSha256\s*=\s*'(?<hash>[A-Fa-f0-9]{64})'")
Assert-GatewayFingerprint 'launcher pins one explicit reviewed fingerprint' $pinMatch.Success
$actualFingerprint = Get-CodexDevinGatewayFingerprint -GatewayRoot $gatewayRoot -OAuthHelperPath $oauthHelperPath
foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $gatewayRoot 'src') -Recurse -File)) {
    if ($file.Extension -eq '.ts') {
        Assert-GatewayFingerprint ('runtime source uses reproducible LF endings: ' + $file.Name) (-not [IO.File]::ReadAllText($file.FullName).Contains("`r`n"))
    }
}
Assert-GatewayFingerprint 'clean-fork runtime source matches the reviewed fingerprint pin' ([string]::Equals($actualFingerprint, $pinMatch.Groups['hash'].Value, [StringComparison]::OrdinalIgnoreCase))

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('devin-gateway-fingerprint-' + [guid]::NewGuid().ToString('N'))))
$fixtureTools = Join-Path $fixtureRoot 'tools\codex-devin'
$fixtureSrc = Join-Path $fixtureRoot 'src'
$fixtureHelper = Join-Path $fixtureTools 'DevinOAuthBridge.ts'
try {
    [void][IO.Directory]::CreateDirectory($fixtureSrc)
    [void][IO.Directory]::CreateDirectory($fixtureTools)
    [IO.File]::WriteAllText((Join-Path $fixtureSrc 'server.ts'), 'synthetic-server-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureSrc 'models.json'), '{"synthetic":true}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'package.json'), '{"name":"synthetic"}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bun.lock'), 'synthetic-lock-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'tsconfig.json'), '{"compilerOptions":{}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bunfig.toml'), "[run]`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fixtureHelper, 'synthetic-oauth-helper-v1', [Text.UTF8Encoding]::new($false))
    $fixtureSelection = Join-Path $fixtureTools 'CodexSelection.ts'
    $fixtureTemplateDirectory = Join-Path $fixtureTools 'templates'
    [void][IO.Directory]::CreateDirectory($fixtureTemplateDirectory)
    $fixtureTemplate = Join-Path $fixtureTemplateDirectory 'codex-synthetic.json'
    [IO.File]::WriteAllText($fixtureSelection, 'synthetic-selection-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fixtureTemplate, '{"synthetic":1}', [Text.UTF8Encoding]::new($false))

    $resolvedFixtureRoot = Resolve-CodexDevinGatewayRoot -ToolDirectory $fixtureTools
    $fixtureFingerprint = Get-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper
    Assert-GatewayFingerprint 'fingerprint includes clean-fork source, package, lockfile, runtime config, and OAuth helper' (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint)
    [IO.File]::WriteAllText($fixtureSelection, 'synthetic-selection-v2', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'changed selection processor fails fingerprint validation' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText($fixtureSelection, 'synthetic-selection-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fixtureTemplate, '{"synthetic":2}', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'changed reviewed runtime metadata fails fingerprint validation' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText($fixtureTemplate, '{"synthetic":1}', [Text.UTF8Encoding]::new($false))

    [IO.File]::WriteAllText((Join-Path $fixtureSrc 'server.ts'), 'synthetic-server-v2', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'a changed runtime source fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText((Join-Path $fixtureSrc 'server.ts'), 'synthetic-server-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'package.json'), '{"name":"changed"}', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'a changed package manifest fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'package.json'), '{"name":"synthetic"}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bun.lock'), 'synthetic-lock-v2', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'a changed Bun lockfile fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bun.lock'), 'synthetic-lock-v1', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'tsconfig.json'), '{"compilerOptions":{"strict":false}}', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'changed runtime configuration fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'tsconfig.json'), '{"compilerOptions":{}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bunfig.toml'), "[run]`nsmol = true`n", [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'changed Bun runtime configuration fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'bunfig.toml'), "[run]`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fixtureHelper, 'synthetic-oauth-helper-v2', [Text.UTF8Encoding]::new($false))
    Assert-GatewayFingerprint 'a changed OAuth helper fails the fingerprint guard' (-not (Test-CodexDevinGatewayFingerprint -GatewayRoot $resolvedFixtureRoot -OAuthHelperPath $fixtureHelper -ExpectedFingerprint $fixtureFingerprint))
} finally {
    $expectedPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar + 'devin-gateway-fingerprint-'
    if (-not $fixtureRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Temporary fingerprint fixture escaped the operating-system temp directory.'
    }
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Host "PASS: $script:passed clean-fork fingerprint checks"
