[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$collapseWrapper = Join-Path $PSScriptRoot 'Run-CodexDevinCollapseTest.ps1'
if (-not (Test-Path -LiteralPath $collapseWrapper -PathType Leaf)) {
    throw "The shared guarded Devin Desktop wrapper is missing: $collapseWrapper"
}

& $collapseWrapper -WorkerTest
