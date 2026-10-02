# Trusted local schema-v2 consumer. No gateway content is evaluated or executed.
function Invoke-CodexDevinSelectionProcess {
    param([string]$Executable, [string[]]$Arguments, [AllowEmptyString()][string]$InputText = '')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $Executable
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $process.StartInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CodexDevinWindowsCommandLineArgument -Argument $_ }) -join ' ')
    $started = $false
    try {
        if (-not $process.Start()) { throw 'Selection validation process could not start.' }
        $started = $true
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $inputBytes = [Text.UTF8Encoding]::new($false).GetBytes($InputText)
        $write = $process.StandardInput.BaseStream.WriteAsync($inputBytes, 0, $inputBytes.Length)
        if (-not $write.Wait(3000)) { throw 'Selection input exceeded its bounded deadline.' }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) { throw 'Selection/runtime validation exceeded ten seconds.' }
        if ($process.ExitCode -ne 0) { throw 'Selection/runtime validation failed; no defaults were substituted.' }
        if (-not $output.Wait(1000) -or -not $errors.Wait(1000)) { throw 'Selection process output exceeded its bounded deadline.' }
        return $output.Result
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

function Get-CodexDevinDesktopRuntime {
    $root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex\bin'
    # Versioned managed backends, never the unrelated legacy top-level executable or npm CLI.
    $candidates = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction Stop | ForEach-Object {
        $candidate = Join-Path $_.FullName 'codex.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    })
    if ($candidates.Count -eq 0) { throw 'No versioned Desktop backend was found.' }
    if ($candidates.Count -gt 1) { throw 'More than one versioned Desktop backend exists; runtime identity needs review before activation.' }
    $path = $candidates[0].FullName
    Assert-CodexDevinNoReparsePoint -Path (Split-Path -Parent $path)
    Assert-CodexDevinNoReparsePoint -Path $path
    $version = (Invoke-CodexDevinSelectionProcess -Executable $path -Arguments @('--version')).Trim()
    if ($version -cne 'codex-cli 0.159.2') { throw 'The installed Desktop backend has no reviewed catalog adapter. No Codex files were changed.' }
    return [pscustomobject]@{ Path = $path; Version = '0.159.2' }
}

function Get-CodexDevinPreparedSelection {
    param([Parameter(Mandatory)][string]$GatewayAuthority)
    Write-Host 'Checking gateway health (3 seconds) and saved selection/discovery (15 seconds)...'
    $health = Get-CodexDevinGatewayHealth -Uri ($GatewayAuthority + '/health')
    if (-not $health.Healthy) { throw 'Gateway health failed before selection preparation; no Codex files were changed.' }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($GatewayAuthority + '/gateway/api/codex-selection') -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
    } catch {
        $status = $null
        if ($_.Exception.PSObject.Properties['Response']) { try { $status = [int]$_.Exception.Response.StatusCode } catch {} }
        if ($status) { throw ('Saved Codex selection failed with HTTP ' + $status + '. Verify model selection is enabled on the selected GatewayUrl; no local fallback was used.') }
        throw 'Saved Codex selection transport failed or exceeded 15 seconds on the selected GatewayUrl; no defaults were substituted.'
    }
    if ($response.StatusCode -ne 200 -or $response.RawContentLength -gt 262144 -or [Text.Encoding]::UTF8.GetByteCount([string]$response.Content) -gt 262144) {
        throw 'Saved Codex selection response is invalid or exceeds the size limit.'
    }
    Write-Host 'Checking the versioned Desktop backend and trusted catalog adapter...'
    $runtime = Get-CodexDevinDesktopRuntime
    $root = Resolve-CodexDevinGatewayRoot -ToolDirectory $PSScriptRoot
    $helper = Join-Path $PSScriptRoot 'CodexSelection.ts'
    $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    $launcher = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Start-DevinGateway.ps1'))
    $pin = [regex]::Match($launcher, "\`$reviewedSourceSha256\s*=\s*'(?<hash>[A-Fa-f0-9]{64})'")
    if (-not $pin.Success -or -not (Test-CodexDevinGatewayFingerprint -GatewayRoot $root -OAuthHelperPath (Join-Path $PSScriptRoot 'DevinOAuthBridge.ts') -ExpectedFingerprint $pin.Groups['hash'].Value)) {
        throw 'Reviewed source/template-processing fingerprint mismatch; no Codex files were changed.'
    }
    $preparedJson = Invoke-CodexDevinSelectionProcess -Executable $bun -Arguments @('--no-env-file', 'run', $helper, $runtime.Version, $runtime.Path) -InputText ([string]$response.Content)
    $prepared = ConvertFrom-Json -InputObject $preparedJson -ErrorAction Stop
    if ($prepared.schemaVersion -ne 1 -or $prepared.runtimeVersion -cne $runtime.Version) { throw 'Local selection preparation returned an invalid result.' }
    $reviewedAdapter = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'templates\codex-0.159.2.json') -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($prepared.instructionSha256 -cne $reviewedAdapter.expectedInstructionSha256 -or $prepared.instructionUtf8ByteLength -ne $reviewedAdapter.expectedInstructionUtf8ByteLength) {
        throw 'Locally sourced Codex instructions do not match the reviewed provenance record.'
    }
    $hash = Get-CodexDevinBytesSha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($prepared.catalogText))
    if ($hash -cne $prepared.catalogSha256) { throw 'Generated catalog bytes do not match their recorded hash.' }
    Write-Host ('Fetched selection revision: ' + $prepared.revision)
    $catalogSummary = ConvertFrom-Json -InputObject $prepared.catalogText -ErrorAction Stop
    Write-Host 'Generated logical models / efforts:'
    foreach ($model in $catalogSummary.models) {
        Write-Host ('  ' + $model.slug + ': ' + (($model.supported_reasoning_levels | ForEach-Object { $_.effort }) -join ', '))
    }
    return $prepared
}
