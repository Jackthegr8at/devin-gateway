[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDevin.Common.ps1')
Import-Module (Join-Path $PSScriptRoot 'CodexDevin.CollapseTest.Guards.psm1') -Force
. (Join-Path $PSScriptRoot 'CodexDevin.Selection.ps1')

function Assert-Selection([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    Write-Host "PASS: $Name"
}
# These overrides exist only in this offline test's scope, never in the production wrapper.
function Get-Process {
    [CmdletBinding()] param()
    $global:CodexDevinSelectionTestContext.ProcessChecks++
    if ($global:CodexDevinSelectionTestContext.Interrupt -and $global:CodexDevinSelectionTestContext.ProcessChecks -eq 3) { throw 'synthetic interruption after worker installation' }
    return @()
}
function Invoke-RestMethod { [CmdletBinding()] param($Uri, $TimeoutSec) return [pscustomobject]@{ status = 'ok'; collapse_system_enabled = $true; fallback_token = 'set' } }
function Invoke-WebRequest {
    [CmdletBinding()] param($Uri, $TimeoutSec, $MaximumRedirection, [switch]$UseBasicParsing)
    if ($global:CodexDevinSelectionTestContext.FailFetch) { throw 'synthetic timeout' }
    if ($global:CodexDevinSelectionTestContext.HttpFailure) {
        $exception = [Exception]::new('synthetic private server detail')
        Add-Member -InputObject $exception -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = 404 })
        throw $exception
    }
    Assert-Selection ($TimeoutSec -eq 15 -and $MaximumRedirection -eq 0) 'selection request has bounded discovery timeout and no redirects'
    Assert-Selection ($Uri -eq ($global:CodexDevinSelectionTestContext.Authority + '/gateway/api/codex-selection')) 'selection URL uses the selected gateway without fallback'
    return [pscustomobject]@{ StatusCode = 200; RawContentLength = $global:CodexDevinSelectionTestContext.Json.Length; Content = $global:CodexDevinSelectionTestContext.Json }
}
$root = Resolve-CodexDevinGatewayRoot -ToolDirectory $PSScriptRoot
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$fixtureCode = 'import {adminModels,codexSelectionManifest} from "./src/admin/model-catalog.ts"; import {initialModelSelection} from "./src/admin/model-selection.ts"; const rows=["glm-5-3-flash-low","swe-2-medium"].map(id=>({id,name:id,contextWindow:128000,maxTokens:8192,supportsImages:false,reasoning:true,upstreamThinking:true,metadataProvenance:{id:"upstream",displayName:"upstream",contextWindow:"upstream",maxOutputTokens:"upstream",imageSupport:"upstream",upstreamThinking:"upstream",reasoning:"upstream_indicator_and_label_heuristic"}})); const state=initialModelSelection(); console.log(JSON.stringify(codexSelectionManifest(state,adminModels(rows,state))));'
$fixtureJson = Invoke-CodexDevinSelectionProcess -Executable $bun -Arguments @('--no-env-file', '-e', $fixtureCode)
$script:fixtureJson = [string]$fixtureJson
$global:CodexDevinSelectionTestContext = @{ Json = $script:fixtureJson; FailFetch = $false; HttpFailure = $false; Authority = ''; ProcessChecks = 0; Interrupt = $false }
$originalHome = $env:CODEX_HOME
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('codex-selection-workflow-' + [guid]::NewGuid().ToString('N'))
try {
    $hashes = @()
    foreach ($mode in @('Local', 'Remote', 'FetchFailure', 'HttpFailure', 'InvalidManifest', 'ExistingWorker', 'Interrupted', 'RuntimeFailure')) {
        $fixtureHome = Join-Path $fixture $mode
        [void][IO.Directory]::CreateDirectory((Join-Path $fixtureHome 'agents'))
        $env:CODEX_HOME = $fixtureHome
        $configPath = Join-Path $fixtureHome 'config.toml'
        $workerPath = Join-Path $fixtureHome 'agents\swe_worker.toml'
        $originalBytes = [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::UTF8.GetBytes("model = `"synthetic-original`"`r`nmodel_reasoning_effort = `"high`"`r`nsandbox_mode = `"workspace-write`"`r`napproval_policy = `"never`"`r`n"))
        [IO.File]::WriteAllBytes($configPath, $originalBytes)
        $existingWorker = $mode -eq 'ExistingWorker'
        $workerBytes = [Text.Encoding]::UTF8.GetBytes("# synthetic pre-existing worker`r`n")
        if ($existingWorker) { [IO.File]::WriteAllBytes($workerPath, $workerBytes) }
        $script:authority = if ($mode -eq 'Local') { 'http://127.0.0.1:38643' } else { 'http://192.0.2.10:38643' }
        $script:failFetch = $mode -eq 'FetchFailure'
        $savedJson = $script:fixtureJson
        if ($mode -eq 'InvalidManifest') { $script:fixtureJson = '{"schemaVersion":99}' }
        $global:CodexDevinSelectionTestContext = @{ Json = $script:fixtureJson; FailFetch = $script:failFetch; HttpFailure = ($mode -eq 'HttpFailure'); Authority = $script:authority; ProcessChecks = 0; Interrupt = ($mode -eq 'Interrupted') }
        $failed = $false
        try { & (Join-Path $PSScriptRoot 'Enable-CodexDevin.ps1') -GatewayBaseUrl ($script:authority + '/v1') } catch { $failed = $true }
        $script:fixtureJson = $savedJson
        if ($mode -in @('FetchFailure', 'HttpFailure', 'InvalidManifest')) {
            Assert-Selection $failed 'failed fetch/validation stops activation'
            Assert-Selection ((Get-CodexDevinSha256 $configPath) -eq (Get-CodexDevinBytesSha256 $originalBytes)) 'failure leaves config byte-for-byte unchanged'
            Assert-Selection (-not (Test-Path (Join-Path $fixtureHome 'devin-desktop-switch-backups'))) 'failure occurs before creating recovery/activation files'
            continue
        }
        if ($mode -eq 'Interrupted') {
            Assert-Selection $failed 'interruption after worker install stops configuration switch'
            $global:CodexDevinSelectionTestContext.Interrupt = $false
            & (Join-Path $PSScriptRoot 'Restore-CodexOpenAI.ps1')
            Assert-Selection ((Get-CodexDevinSha256 $configPath) -ceq (Get-CodexDevinBytesSha256 $originalBytes)) 'interrupted activation restores original config bytes'
            Assert-Selection (-not (Test-Path $workerPath)) 'interrupted activation removes managed worker'
            continue
        }
        Assert-Selection (-not $failed) "isolated activation succeeds: $mode"
        $config = [IO.File]::ReadAllText($configPath)
        $worker = [IO.File]::ReadAllText($workerPath)
        Assert-Selection ($config.Contains('model = "glm-5-3-flash-low"') -and $config.Contains('model_reasoning_effort = "low"')) 'parent preserves saved model and effort, replacing previous effort'
        Assert-Selection ($config.Contains('sandbox_mode = "workspace-write"') -and $config.Contains('approval_policy = "never"')) 'security settings preserved'
        Assert-Selection ($config.Contains('base_url = "' + $script:authority + '/v1"')) 'provider uses selected gateway'
        Assert-Selection ($worker.Contains('model = "swe-2"') -and $worker.Contains('model_reasoning_effort = "medium"') -and -not $worker.Contains('model_provider')) 'worker uses logical model, explicit medium and inherited provider'
        $run = @(Get-ChildItem (Join-Path $fixtureHome 'devin-desktop-switch-backups') -Directory)[0]
        $state = Get-Content (Join-Path $run.FullName 'state.json') -Raw | ConvertFrom-Json
        $runtime = Get-CodexDevinDesktopRuntime
        Assert-Selection ((Get-CodexDevinSha256 $state.catalogPath) -ceq $state.catalogSha256 -and $state.selectionRevision -eq 1 -and $state.runtimeVersion -ceq $runtime.Version -and $state.instructionSha256 -ceq 'B707476816BFE5E571A1BD2179F130FFF2B132DA5AB8E61063ACDB7FD24DAF12' -and $state.instructionUtf8ByteLength -eq 18043) 'recovery records catalog integrity and runtime/instruction provenance'
        Assert-Selection ($state.compatibilityContractVersion -eq 1 -and $state.runtimeExecutablePath -ceq $runtime.Path -and $state.runtimeExecutableSha256 -ceq $runtime.ExecutableSha256) 'recovery records passed contract and exact managed executable fingerprint'
        $hashes += $state.catalogSha256
        if ($mode -eq 'Local') {
            $runtime = Get-CodexDevinDesktopRuntime
            $effective = Invoke-CodexDevinSelectionProcess -Executable $runtime.Path -Arguments @('debug', 'models') | ConvertFrom-Json
            $loaded = @($effective.models)
            Assert-Selection ($loaded.Count -eq 2) 'installed reviewed runtime loads only the generated reviewed models offline'
            $generated = Get-Content -LiteralPath $state.catalogPath -Raw | ConvertFrom-Json
            Assert-Selection (@($generated.models | Where-Object { $_.multi_agent_version -cne 'v1' -or $_.shell_type -cne 'shell_command' }).Count -eq 0) 'generated catalog preserves reviewed V1 and shell metadata'
            Assert-Selection (@($loaded | Where-Object { $_.multi_agent_version -cne 'v1' }).Count -eq 0) 'effective runtime preserves reviewed V1 metadata'
            Write-Host ('Effective runtime shell metadata: ' + (($loaded | ForEach-Object { $_.slug + ':' + $_.shell_type + ':' + $_.multi_agent_version }) -join ', '))
            # All mutations below are confined to this disposable fixture catalog.
            # Compare complete effective structures in memory; never print instructions.
            $catalogBytes = [IO.File]::ReadAllBytes($state.catalogPath)
            $configHashBeforeAliasProbe = Get-CodexDevinSha256 $configPath
            try {
                foreach ($model in $generated.models) { $model.shell_type = 'unified_exec' }
                [IO.File]::WriteAllText($state.catalogPath, ($generated | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
                $canonical = Invoke-CodexDevinSelectionProcess -Executable $runtime.Path -Arguments @('debug', 'models') | ConvertFrom-Json
                Assert-Selection (($effective | ConvertTo-Json -Depth 100 -Compress) -ceq ($canonical | ConvertTo-Json -Depth 100 -Compress)) 'legacy shell_command and canonical unified_exec yield identical complete effective catalogs'
                foreach ($model in $generated.models) { $model.shell_type = 'disabled' }
                [IO.File]::WriteAllText($state.catalogPath, ($generated | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
                $disabled = Invoke-CodexDevinSelectionProcess -Executable $runtime.Path -Arguments @('debug', 'models') | ConvertFrom-Json
                Assert-Selection (@($disabled.models | Where-Object { $_.shell_type -cne 'disabled' }).Count -eq 0) 'disabled remains disabled: shell normalization is not an unconditional capability override'
            } finally { [IO.File]::WriteAllBytes($state.catalogPath, $catalogBytes) }
            Assert-Selection ((Get-CodexDevinSha256 $state.catalogPath) -ceq $state.catalogSha256) 'alias probe restores original generated catalog hash'
            Assert-Selection ((Get-CodexDevinSha256 $configPath) -ceq $configHashBeforeAliasProbe) 'alias probe leaves provider and security configuration unchanged'
            $glm = @($loaded | Where-Object slug -CEQ 'glm-5-3-flash-low')[0]
            $swe = @($loaded | Where-Object slug -CEQ 'swe-2')[0]
            Assert-Selection ($glm.default_reasoning_level -ceq 'low' -and $swe.default_reasoning_level -ceq 'medium') 'runtime catalog reports exact baseline default efforts'
            Assert-Selection ($glm.supported_reasoning_levels.Count -eq 1 -and $swe.supported_reasoning_levels.Count -eq 1) 'runtime catalog advertises no invented efforts'
        }
        if ($mode -eq 'RuntimeFailure') {
            # Simulate an upstream model denial after activation, without a model request.
            try { throw 'synthetic runtime model failure' }
            catch { Assert-Selection ($_.Exception -ne $null) 'runtime failure remains explicit without model substitution' }
            finally { & (Join-Path $PSScriptRoot 'Restore-CodexOpenAI.ps1') }
        } else { & (Join-Path $PSScriptRoot 'Restore-CodexOpenAI.ps1') }
        Assert-Selection ((Get-CodexDevinSha256 $configPath) -ceq (Get-CodexDevinBytesSha256 $originalBytes)) 'config restores original BOM and bytes'
        if ($existingWorker) { Assert-Selection ((Get-CodexDevinSha256 $workerPath) -ceq (Get-CodexDevinBytesSha256 $workerBytes)) 'existing worker restores byte-for-byte' }
        else { Assert-Selection (-not (Test-Path $workerPath)) 'managed worker removed after restore' }
    }
    Assert-Selection (@($hashes | Select-Object -Unique).Count -eq 1) 'local and remote selection generate identical catalog hashes'
    # Seven synthetic discovered variants, actual local runtime; no network or inference.
    $fullFixtureCode = 'import {familyFixture as f} from "./test/fixtures/model-families.ts"; import {adminModels,codexSelectionManifest} from "./src/admin/model-catalog.ts"; import {initialModelSelection} from "./src/admin/model-selection.ts"; const rows=[f("swe-2-medium","SWE-2","medium"),f("swe-2-high","SWE-2","high"),f("swe-2-max","SWE-2","max"),f("gpt-5-6-luna-max","GPT-5.6 Luna","max"),f("gpt-6-1-sol-low","GPT-6.1 Sol","low"),f("gpt-6-1-sol-medium","GPT-6.1 Sol","medium"),f("glm-5-3-flash-low","GLM-5.3 Flash","low",{context1m:true})]; const state={...initialModelSelection(),enabledModels:rows.map(m=>m.id)}; console.log(JSON.stringify(codexSelectionManifest(state,adminModels(rows,state))));'
    $fullManifest = Invoke-CodexDevinSelectionProcess -Executable $bun -Arguments @('--no-env-file', '-e', $fullFixtureCode)
    $runtime = Get-CodexDevinDesktopRuntime
    $preparedJson = Invoke-CodexDevinSelectionProcess -Executable $bun -Arguments @('--no-env-file','run',(Join-Path $PSScriptRoot 'CodexSelection.ts'),$runtime.Version,$runtime.Path) -InputText $fullManifest
    $fullPrepared = ConvertFrom-Json $preparedJson
    $fullCatalog = ConvertFrom-Json $fullPrepared.catalogText
    Assert-Selection ($fullPrepared.compatibilityContractVersion -eq 1 -and $fullPrepared.runtimeVersion -ceq $runtime.Version) 'installed backend passes contract without version membership'
    $expected = @{
        'glm-5-3-flash-1m' = @('low','low')
        'gpt-5-6-luna' = @('max','max')
        'gpt-6-1-sol' = @('low','low,medium')
        'swe-2' = @('medium','medium,high,max')
    }
    Assert-Selection ($fullCatalog.models.Count -eq $expected.Count) 'full logical model set accepted by installed backend'
    foreach ($model in $fullCatalog.models) {
        Assert-Selection ($expected.ContainsKey($model.slug) -and $model.default_reasoning_level -ceq $expected[$model.slug][0] -and (($model.supported_reasoning_levels | ForEach-Object effort) -join ',') -ceq $expected[$model.slug][1]) ('exact logical efforts preserved: ' + $model.slug)
    }
} finally {
    Remove-Variable -Name CodexDevinSelectionTestContext -Scope Global -ErrorAction SilentlyContinue
    if ($null -eq $originalHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $originalHome }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\codex-selection-workflow-'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup target.' }
    if ([IO.Directory]::Exists($resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
