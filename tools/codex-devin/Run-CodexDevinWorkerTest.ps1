[CmdletBinding()]
param(
    [string]$GatewayUrl = 'http://127.0.0.1:38643',
    [string]$RemoteSshTarget,
    [string]$RemoteGatewayDirectory,
    [string]$RemoteSshIdentityFile
)

$ErrorActionPreference = 'Stop'
$collapseWrapper = Join-Path $PSScriptRoot 'Run-CodexDevinCollapseTest.ps1'
if (-not (Test-Path -LiteralPath $collapseWrapper -PathType Leaf)) {
    throw "The shared guarded Devin Desktop wrapper is missing: $collapseWrapper"
}

& $collapseWrapper -WorkerTest -GatewayUrl $GatewayUrl -RemoteSshTarget $RemoteSshTarget -RemoteGatewayDirectory $RemoteGatewayDirectory -RemoteSshIdentityFile $RemoteSshIdentityFile
