[CmdletBinding()]
param(
    [string]$GatewayBaseUrl = 'http://127.0.0.1:38643/v1'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')

$codexHome = Get-CodexDevinHome
$configPath = Join-Path $codexHome 'config.toml'
$agentPath = Join-Path $codexHome 'agents\swe_worker.toml'
$catalogPath = Join-Path $codexHome 'model-catalogs\devin-0.158.json'
$catalogSha256 = '0ED2DF70B20D3CD5EFFF5747D71A84553CBA1085BA42F6D0EDE9F455CDD7065A'
$backupRoot = Join-Path $codexHome 'devin-desktop-switch-backups'
$runDirectory = $null
$statePath = $null

$gatewayUri = $null
if (-not [Uri]::TryCreate($GatewayBaseUrl, [UriKind]::Absolute, [ref]$gatewayUri)) {
    throw 'GatewayBaseUrl must be an absolute HTTP gateway URL ending in /v1.'
}
if (
    $gatewayUri.Scheme -cne 'http' -or
    $gatewayUri.AbsolutePath -cne '/v1' -or
    $gatewayUri.UserInfo -or
    $gatewayUri.Query -or
    $gatewayUri.Fragment
) {
    throw 'GatewayBaseUrl must use http://<gateway-host>:<port>/v1 with no credentials, query, or fragment.'
}
$gatewayAuthority = $gatewayUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$gatewayBaseUrl = "$gatewayAuthority/v1"
$gatewayHealthUri = "$gatewayAuthority/health"

function Save-SwitchState($State) {
    $json = ConvertTo-Json -InputObject $State -Depth 8
    Write-CodexDevinTextAtomically -Path $statePath -Text ($json + "`r`n")
}

function Read-ConfigText([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $offset = if ($hasBom) { 3 } else { 0 }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset)
    return [pscustomobject]@{ Bytes = $bytes; Text = $text; HasBom = $hasBom }
}

try {
    Write-Host '[1/8] Checking the user profile and Codex Desktop/app-server processes...'
    Assert-CodexDevinProfile
    Assert-CodexDevinStopped

    Write-Host '[2/8] Validating config, worker, catalog, and recovery state...'
    Assert-CodexDevinNoReparsePoint -Path $codexHome
    Assert-CodexDevinNoReparsePoint -Path $backupRoot
    Assert-CodexDevinNoReparsePoint -Path (Join-Path $codexHome 'agents')
    Assert-CodexDevinNoReparsePoint -Path (Join-Path $codexHome 'model-catalogs')
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Codex config was not found: $configPath" }
    if ((Get-Item -LiteralPath $configPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The Codex config is a reparse point; refusing to switch it.' }
    $document = Read-ConfigText -Path $configPath
    if ((Get-CodexDevinTomlSpan -Text $document.Text -Section 'agents.swe_worker').Found) {
        throw 'A pre-existing [agents.swe_worker] config section needs manual review; refusing to replace its role settings.'
    }
    if ((Get-CodexDevinTomlSpan -Text $document.Text -Section 'model_providers.devin_gateway').Found) {
        throw 'A pre-existing [model_providers.devin_gateway] section needs manual review; refusing to reuse its provider settings.'
    }
    if (Test-Path -LiteralPath $agentPath -PathType Container) { throw "The worker path is a directory: $agentPath" }
    if ((Test-Path -LiteralPath $agentPath -PathType Leaf) -and ((Get-Item -LiteralPath $agentPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The existing worker file is a reparse point; refusing to replace it.'
    }

    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
        throw "The validated durable Devin model catalog is missing: $catalogPath"
    }
    Assert-CodexDevinNoReparsePoint -Path $catalogPath
    if ((Get-CodexDevinSha256 -Path $catalogPath) -ne $catalogSha256) {
        throw 'The validated durable Devin model catalog has changed; refusing to switch.'
    }
    $catalogText = [IO.File]::ReadAllText($catalogPath, [Text.UTF8Encoding]::new($false, $true))
    Assert-CodexDevinCatalogModels -JsonText $catalogText -RequiredSlugs @('glm-5-3-flash-low', 'swe-2-medium')

    if (Test-Path -LiteralPath $backupRoot -PathType Container) {
        foreach ($existingRun in @(Get-ChildItem -LiteralPath $backupRoot -Directory)) {
            $existingStatePath = Join-Path $existingRun.FullName 'state.json'
            if (-not (Test-Path -LiteralPath $existingStatePath -PathType Leaf)) {
                throw "An incomplete backup directory needs review before switching: $($existingRun.FullName)"
            }
            try { $existingState = Get-Content -LiteralPath $existingStatePath -Raw | ConvertFrom-Json } catch {
                throw "An unreadable backup state needs review before switching: $existingStatePath"
            }
            if ($existingState.status -notin @('Restored', 'ResolvedBeforeSwitch')) {
                throw "An unresolved Devin-mode backup already exists: $($existingRun.FullName). Run Restore-CodexOpenAI.ps1 first."
            }
        }
    }

    Write-Host '[3/8] Saving byte-for-byte recovery backups and recording their hashes...'
    # Re-read immediately before creating the run record so the bytes used to stage
    # Devin mode are exactly the bytes saved as this run's restore baseline.
    $document = Read-ConfigText -Path $configPath
    if ((Get-CodexDevinTomlSpan -Text $document.Text -Section 'agents.swe_worker').Found) {
        throw 'A pre-existing [agents.swe_worker] config section needs manual review; refusing to replace its role settings.'
    }
    if ((Get-CodexDevinTomlSpan -Text $document.Text -Section 'model_providers.devin_gateway').Found) {
        throw 'A pre-existing [model_providers.devin_gateway] section needs manual review; refusing to reuse its provider settings.'
    }
    $workerExisted = Test-Path -LiteralPath $agentPath -PathType Leaf
    $configOriginalHash = Get-CodexDevinBytesSha256 -Bytes $document.Bytes
    $workerOriginalHash = if ($workerExisted) { Get-CodexDevinSha256 -Path $agentPath } else { $null }
    [void][IO.Directory]::CreateDirectory($backupRoot)
    $runDirectory = Join-Path $backupRoot ((Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    [void][IO.Directory]::CreateDirectory($runDirectory)
    $statePath = Join-Path $runDirectory 'state.json'
    $workerBytes = Get-CodexDevinWorkerBytes
    $workerManagedHash = Get-CodexDevinBytesSha256 -Bytes $workerBytes
    $workerBackupPath = $null
    if ($workerExisted) { $workerBackupPath = Join-Path $runDirectory 'swe_worker.toml.original' }
    $state = [ordered]@{
        version = 1
        status = 'Preparing'
        createdUtc = [DateTime]::UtcNow.ToString('o')
        configPath = $configPath
        configBackup = (Join-Path $runDirectory 'config.toml.original')
        configOriginalSha256 = $configOriginalHash
        workerPath = $agentPath
        workerExisted = $workerExisted
        workerBackup = $workerBackupPath
        workerOriginalSha256 = $workerOriginalHash
        workerManagedSha256 = $workerManagedHash
        catalogPath = $catalogPath
        catalogSha256 = $catalogSha256
    }
    Save-SwitchState $state

    [IO.File]::Copy($configPath, $state.configBackup, $false)
    if ((Get-CodexDevinSha256 -Path $state.configBackup) -ne $configOriginalHash) { throw 'Config backup verification failed.' }
    if ((Get-CodexDevinSha256 -Path $configPath) -ne $configOriginalHash) { throw 'The active config changed while its restore baseline was being saved; refusing to continue.' }
    if ($workerExisted) {
        [IO.File]::Copy($agentPath, $state.workerBackup, $false)
        if ((Get-CodexDevinSha256 -Path $state.workerBackup) -ne $workerOriginalHash) { throw 'Worker backup verification failed.' }
    }
    $state.status = 'Prepared'
    Save-SwitchState $state

    Write-Host '[4/8] Revalidating the durable Devin model catalog...'
    Assert-CodexDevinNoReparsePoint -Path $catalogPath
    if ((Get-CodexDevinSha256 -Path $catalogPath) -ne $catalogSha256) { throw 'Durable catalog SHA-256 changed before the config switch.' }
    $catalogText = [IO.File]::ReadAllText($catalogPath, [Text.UTF8Encoding]::new($false, $true))
    Assert-CodexDevinCatalogModels -JsonText $catalogText -RequiredSlugs @('glm-5-3-flash-low', 'swe-2-medium')
    $state.status = 'CatalogReady'
    Save-SwitchState $state

    Write-Host '[5/8] Staging and validating the temporary Devin configuration...'
    $text = $document.Text
    $sandboxBefore = Get-CodexDevinTomlKeyLine -Text $text -Section '' -Key 'sandbox_mode'
    $approvalBefore = Get-CodexDevinTomlKeyLine -Text $text -Section '' -Key 'approval_policy'

    $text = Set-CodexDevinTomlKey -Text $text -Section '' -Key 'model' -Value '"glm-5-3-flash-low"'
    $text = Set-CodexDevinTomlKey -Text $text -Section '' -Key 'model_provider' -Value '"devin_gateway"'
    $text = Set-CodexDevinTomlKey -Text $text -Section '' -Key 'model_catalog_json' -Value (ConvertTo-CodexDevinTomlString -Value $catalogPath)
    $text = Set-CodexDevinTomlKey -Text $text -Section '' -Key 'multi_agent_version' -Value '"v1"'

    $providerSection = 'model_providers.devin_gateway'
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'name' -Value '"Devin Gateway"'
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'base_url' -Value (ConvertTo-CodexDevinTomlString -Value $gatewayBaseUrl)
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'wire_api' -Value '"responses"'
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'requires_openai_auth' -Value 'false'
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'request_max_retries' -Value '0'
    $text = Set-CodexDevinTomlKey -Text $text -Section $providerSection -Key 'stream_max_retries' -Value '0'

    $agentSection = 'agents.swe_worker'
    $text = Set-CodexDevinTomlKey -Text $text -Section $agentSection -Key 'description' -Value '"Scoped SWE-2 Medium repository worker."'
    $text = Set-CodexDevinTomlKey -Text $text -Section $agentSection -Key 'config_file' -Value (ConvertTo-CodexDevinTomlString -Value $agentPath)

    if ((Get-CodexDevinTomlKeyLine -Text $text -Section '' -Key 'sandbox_mode') -cne $sandboxBefore) { throw 'Internal validation failed: sandbox_mode would change.' }
    if ((Get-CodexDevinTomlKeyLine -Text $text -Section '' -Key 'approval_policy') -cne $approvalBefore) { throw 'Internal validation failed: approval_policy would change.' }
    foreach ($expected in @(
        @{ Section = ''; Key = 'model'; Pattern = '^\s*model\s*=\s*"glm-5-3-flash-low"' }
        @{ Section = ''; Key = 'model_provider'; Pattern = '^\s*model_provider\s*=\s*"devin_gateway"' }
        @{ Section = ''; Key = 'model_catalog_json'; Pattern = '^\s*model_catalog_json\s*=' }
        @{ Section = ''; Key = 'multi_agent_version'; Pattern = '^\s*multi_agent_version\s*=\s*"v1"' }
        @{ Section = $providerSection; Key = 'base_url'; Pattern = '^\s*base_url\s*=\s*' + [regex]::Escape((ConvertTo-CodexDevinTomlString -Value $gatewayBaseUrl)) }
        @{ Section = $providerSection; Key = 'wire_api'; Pattern = '^\s*wire_api\s*=\s*"responses"' }
        @{ Section = $providerSection; Key = 'requires_openai_auth'; Pattern = '^\s*requires_openai_auth\s*=\s*false' }
        @{ Section = $providerSection; Key = 'request_max_retries'; Pattern = '^\s*request_max_retries\s*=\s*0' }
        @{ Section = $providerSection; Key = 'stream_max_retries'; Pattern = '^\s*stream_max_retries\s*=\s*0' }
    )) {
        $line = Get-CodexDevinTomlKeyLine -Text $text -Section $expected.Section -Key $expected.Key
        if ($null -eq $line -or $line -notmatch $expected.Pattern) { throw "Internal validation failed for temporary setting '$($expected.Key)'." }
    }

    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $configBytes = $encoding.GetBytes($text)
    if ($document.HasBom) { $configBytes = [byte[]](@(0xEF, 0xBB, 0xBF) + $configBytes) }
    $expectedConfigHash = Get-CodexDevinBytesSha256 -Bytes $configBytes
    $state.enabledConfigSha256 = $expectedConfigHash

    Write-Host '[6/8] Rechecking processes and installing the temporary SWE worker...'
    Assert-CodexDevinStopped
    if ((Get-CodexDevinSha256 -Path $configPath) -ne $configOriginalHash) { throw 'The active config changed after backup; refusing to overwrite that change.' }
    if ($workerExisted) {
        if ((Get-CodexDevinSha256 -Path $agentPath) -ne $workerOriginalHash) { throw 'The worker file changed after backup; refusing to overwrite that change.' }
    } elseif (Test-Path -LiteralPath $agentPath) {
        throw 'A worker file appeared after the backup; refusing to overwrite it.'
    }

    $workerDirectory = Split-Path -Parent $agentPath
    Assert-CodexDevinNoReparsePoint -Path $workerDirectory
    [void][IO.Directory]::CreateDirectory($workerDirectory)
    Assert-CodexDevinNoReparsePoint -Path $agentPath
    $state.status = 'WorkerInstalling'
    Save-SwitchState $state
    Write-CodexDevinBytesAtomically -Path $agentPath -Bytes $workerBytes
    if ((Get-CodexDevinSha256 -Path $agentPath) -ne $workerManagedHash) { throw 'Installed SWE worker verification failed.' }
    $state.status = 'WorkerInstalled'
    Save-SwitchState $state

    Write-Host '[7/8] Rechecking processes and switching the active config atomically...'
    Assert-CodexDevinStopped
    Assert-CodexDevinNoReparsePoint -Path $configPath
    Write-CodexDevinBytesAtomically -Path $configPath -Bytes $configBytes
    if ((Get-CodexDevinSha256 -Path $configPath) -ne $expectedConfigHash) { throw 'Active Devin config hash verification failed.' }
    $state.status = 'Enabled'
    $state.enabledConfigSha256 = (Get-CodexDevinSha256 -Path $configPath)
    Save-SwitchState $state

    Write-Host 'Temporary provider mode configured for the normal Codex Desktop home.'
    Write-Host "Responses endpoint: $gatewayBaseUrl"
    Write-Host "Recovery backup: $runDirectory"
    Write-Host 'The durable model catalog is dormant after OpenAI restore and is intentionally retained.'
    Write-Host '[8/8] Checking loopback gateway health (maximum 3 seconds)...'
    $health = Get-CodexDevinGatewayHealth -Uri $gatewayHealthUri
    if ($health.Healthy) {
        Write-Host 'Gateway health: OK. You may now launch Codex Desktop manually.'
    } else {
        Write-Warning 'Devin mode configured, but gateway is not running. The bounded /health probe did not return status=ok within 3 seconds; start DevinGateway and verify /health before launching Codex Desktop.'
    }
} catch {
    [Console]::Error.WriteLine('Enable failed: ' + $_.Exception.Message)
    if ($runDirectory) {
        [Console]::Error.WriteLine("Recovery directory: $runDirectory")
        [Console]::Error.WriteLine('After confirming Codex Desktop is closed, run Restore-CodexOpenAI.ps1 from this folder.')
    }
    throw 'Enable did not complete. Review the message above; the recovery script remains independently usable.'
}
