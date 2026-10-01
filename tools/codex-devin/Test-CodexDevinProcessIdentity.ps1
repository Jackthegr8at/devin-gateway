[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')

$desktopRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex')).TrimEnd('\') + '\'
$desktopProcessPath = Join-Path $desktopRoot 'bin\test-runtime\codex.exe'
$cliProcessPath = 'C:\Program Files\nodejs\codex.exe'
$sandboxProcessPath = Join-Path $desktopRoot 'codex-windows-sandbox-service.exe'
$syntheticProcesses = @(
    [pscustomobject]@{ ProcessName = 'codex'; Path = $desktopProcessPath; Id = 101 }
    [pscustomobject]@{ ProcessName = 'codex'; Path = $cliProcessPath; Id = 102 }
    [pscustomobject]@{ ProcessName = 'codex-windows-sandbox-service'; Path = $sandboxProcessPath; Id = 103 }
    [pscustomobject]@{ ProcessName = 'bun'; Path = (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'); Id = 104 }
)

$blocked = @(Get-CodexDevinBlockingProcesses -Processes $syntheticProcesses)
if ($blocked.Count -ne 1 -or $blocked[0].ProcessId -ne 101) {
    throw 'The Desktop process guard did not block only the bundled Codex runtime.'
}
Write-Host 'PASS: bundled Desktop Codex runtime is blocked; normal CLI, sandbox service, and unrelated helpers are ignored.'

$missingPathRejected = $false
try {
    [void](Get-CodexDevinBlockingProcesses -Processes @([pscustomobject]@{ ProcessName = 'codex'; Path = ''; Id = 105 }))
} catch {
    $missingPathRejected = $_.Exception.Message -match 'Cannot identify the executable path'
}
if (-not $missingPathRejected) { throw 'A Codex process with unknown executable identity was not rejected fail-closed.' }
Write-Host 'PASS: unknown Codex executable identity is rejected fail-closed.'
