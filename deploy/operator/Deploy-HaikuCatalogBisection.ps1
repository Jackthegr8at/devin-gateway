<#
.SYNOPSIS
Deploy the committed Haiku catalog-bisection diagnostic only after Codex is fully closed.
.DESCRIPTION
Uses the existing operator phases and rollback image/volume backups. Does not
stop Codex, alter its configuration, perform inference, or modify Nginx.
Run -ValidateOnly for offline parameter/AST checks. Run -Rollback to restore
the original source/image. Environment and persistent data must stay byte-exact.
Keep the deployment manifest. This script does not change the separate Codex runner.
Gateway-only deployment uses credential-free primary-proxy HTTPS GET checks.
It never runs privileged Nginx phases. Use a fresh StateDir after a failed preparation;
the previous manifest and backups must be retained for recovery.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$TargetCommit,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]*$')][string]$BundleRef,
    [switch]$ValidateOnly,
    [switch]$Rollback,
    [string]$SshTarget = $env:DEVIN_OPERATOR_SSH_TARGET,
    [string]$NginxTarget = $env:DEVIN_OPERATOR_NGINX_TARGET,
    [string]$NginxAddress = $env:DEVIN_OPERATOR_NGINX_ADDRESS,
    [string]$SshKey = $env:DEVIN_OPERATOR_SSH_KEY,
    [string]$RemoteDir = $env:DEVIN_OPERATOR_REMOTE_DIR,
    [string]$GatewayHost = $env:DEVIN_OPERATOR_GATEWAY_HOST,
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA ('DevinGatewayDeploy\haiku-full-catalog-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$commit = $TargetCommit
$baseline = 'f8168bc941e83df196eb37f20b1d94d9b092177d'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$operator = Join-Path $PSScriptRoot 'Invoke-DevinDeploy.ps1'
if (-not (Test-Path -LiteralPath $operator -PathType Leaf)) { throw 'Private Invoke-DevinDeploy.ps1 is not included in this public snapshot; use an independently reviewed deployment procedure.' }
if ((Get-FileHash -LiteralPath $operator -Algorithm SHA256).Hash -ne 'A7A38CA2189780FA9C9E0F50A43D0650E709317DECCCBF350C187FACF804290C') { throw 'Reviewed operator script changed; refusing to deploy' }
$manifest = Join-Path $StateDir 'deploy-manifest.json'
$extraState = Join-Path $StateDir 'haiku-catalog-bisection-state.json'
$pwsh = (Get-Command pwsh -CommandType Application -ErrorAction Stop).Source
$operatorParameters = (Get-Command $operator -ErrorAction Stop).Parameters
foreach ($parameter in @('Phase','Commit','ExpectedPreCommit','BundleRef','SshTarget','SshKey','GatewayHost','RemoteDir','LocalRepo','StateDir','ManifestPath','ApprovedBy','CodexStopped','NginxTarget','NginxAddress','GatewayOnly')) {
    if (-not $operatorParameters.ContainsKey($parameter)) { throw "Operator parameter missing: $parameter" }
}
if ($RemoteDir -notmatch '^/[A-Za-z0-9/_-]+$' -or $SshTarget -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$' -or $NginxTarget -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$') { throw 'Unsafe remote path/target' }
$common = @('-NoProfile','-File',$operator,'-Commit',$commit,'-ExpectedPreCommit',$baseline,'-BundleRef',$BundleRef,'-SshTarget',$SshTarget,'-SshKey',$SshKey,'-GatewayHost',$GatewayHost,'-RemoteDir',$RemoteDir,'-LocalRepo',$repo,'-StateDir',$StateDir,'-ManifestPath',$manifest,'-GatewayOnly','-NginxTarget',$NginxTarget,'-NginxAddress',$NginxAddress)

function Assert-DesktopStopped {
    $processes = @(Get-Process -ErrorAction Stop)
    if (@($processes | Where-Object { $_.ProcessName -match '^(codex|CodexDesktop)$' }).Count -gt 0) {
        throw 'Codex Desktop/backend is still running. Close it normally; no process was stopped.'
    }
}
function New-GuardedOperatorCopy {
    # Preserve the original operator file. Add only a stop check immediately
    # before its post-build cutover and when entering its rollback function.
    $source = [IO.File]::ReadAllText($operator).Replace("`r`n","`n")
    $guard = @'
if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match '^(codex|CodexDesktop)$' }).Count -gt 0) { throw 'Codex reopened; cutover/rollback refused. Close it normally before rollback.' }
'@
    $cutover = "  Say 'Image built. Recreating only devin-gateway.' Cyan"
    $rollbackEntry = 'function Invoke-RollbackCore($M) {'
    foreach ($anchor in @($cutover,$rollbackEntry)) {
        if (($source.Split([string[]]@($anchor),[StringSplitOptions]::None)).Count -ne 2) { throw 'Operator guard insertion point changed' }
    }
    $source = $source.Replace($cutover, ($guard + "`n" + $cutover)).Replace($rollbackEntry, ($rollbackEntry + "`n" + $guard))

    # Only replace the uniquely indented deployment command. Rollback keeps
    # the original Compose invocation and therefore restores the baseline flags.
    $deployCommand = "      'sudo -n docker compose up -d --no-deps --force-recreate devin-gateway',"
    if (($source.Split([string[]]@($deployCommand),[StringSplitOptions]::None)).Count -ne 2) { throw 'Cutover command changed; refusing activation' }
    $activeCommand = "      'sudo -n env DEVIN_RESPONSES_CATALOG_BISECTION=1 DEVIN_RESPONSES_SAFE_DIAGNOSTICS=1 DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS=1 DEVIN_RESPONSES_FULL_CATALOG_RETENTION=20 DEVIN_RESPONSES_FULL_CATALOG_DIR=/app/logs/haiku-full-catalog-20261027 docker compose up -d --no-deps --force-recreate devin-gateway',"
    $source = $source.Replace($deployCommand, $activeCommand)
    # Restore the actual baseline's enabled diagnostics even though they were
    # supplied as Compose environment overrides rather than persisted in .env.
    $rollbackCommand = "    'sudo -n docker compose up -d --no-deps --force-recreate devin-gateway',"
    $baselineCommand = "    'sudo -n env DEVIN_RESPONSES_SAFE_DIAGNOSTICS=1 DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS=1 DEVIN_RESPONSES_FULL_CATALOG_RETENTION=20 DEVIN_RESPONSES_FULL_CATALOG_DIR=/app/logs/haiku-full-catalog-20261027 docker compose up -d --no-deps --force-recreate devin-gateway',"
    if (($source.Split([string[]]@($rollbackCommand),[StringSplitOptions]::None)).Count -ne 2) { throw 'Rollback command changed; refusing activation' }
    $source = $source.Replace($rollbackCommand, $baselineCommand)

    # Bundle commands must run in LocalRepo regardless of the caller's cwd.
    foreach ($command in @('bundle verify $out','bundle list-heads $out')) {
        $old = 'git -c "safe.directory=$LocalRepo" ' + $command
        $new = 'git -c "safe.directory=$LocalRepo" -C $LocalRepo ' + $command
        if (($source.Split([string[]]@($old),[StringSplitOptions]::None)).Count -ne 2) { throw "Bundle verification anchor changed: $command" }
        $source = $source.Replace($old, $new)
    }


    $path = Join-Path $StateDir 'Invoke-DevinDeploy.guarded.ps1'
    [IO.File]::WriteAllText($path,$source,[Text.UTF8Encoding]::new($false))
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Generated guarded operator AST invalid' }
    $common[2] = $path
}
function Invoke-Phase([string]$Name, [string[]]$Extra = @()) {
    Write-Host "Operator phase: $Name"
    & $pwsh @common -Phase $Name @Extra
    if ($LASTEXITCODE -ne 0) { throw "Operator phase $Name failed (exit $LASTEXITCODE)" }
}
function Invoke-PrivatePython([string]$Code) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Code.Replace("`r",'')))
    $remoteCommand = 'sudo -n python3 -c ''import base64;exec(base64.b64decode("' + $encoded + '"))'''
    $output = @(& ssh.exe -i $SshKey -o BatchMode=yes -o ConnectTimeout=20 $SshTarget $remoteCommand 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Remote verification/update failed (SSH exit $LASTEXITCODE); output withheld to protect secrets" }
    $json = @($output | Where-Object { [string]$_ -match '^\{.*\}$' })
    if ($json.Count -ne 1) { throw 'Remote verification returned an invalid result; output withheld' }
    return ($json[0] | ConvertFrom-Json)
}
function Get-PrivateSnapshot {
    Invoke-PrivatePython @"
import hashlib,itertools,json,pathlib,stat,subprocess
mounts=json.loads(subprocess.check_output(['docker','inspect','devin-gateway-devin-gateway-1','--format','{{json .Mounts}}']))
expected={'devin-gateway_devin-gateway-auth','devin-gateway_devin-gateway-settings'}
assert {m.get('Name') for m in mounts if m['Type']=='volume'}==expected
destinations={m['Destination']:m for m in mounts}
assert len(mounts)==3 and len(destinations)==3
for kind in ['auth','settings']:
 destination='/home/gateway/.devin-gateway'+('-settings' if kind=='settings' else '')
 m=destinations[destination]
 assert m['Type']=='volume' and m['Name']=='devin-gateway_devin-gateway-'+kind and m['RW'] is True
assert destinations['/app/logs']['Type']=='bind' and destinations['/app/logs']['Source']=='$RemoteDir/logs' and destinations['/app/logs']['RW'] is True
# Docker may reorder mounts or represent a named volume's mode as z versus rw.
# z is an inactive SELinux label option ONLY when SELinux is disabled. Preserve
# all other fields and reject every other mode; never normalize bind mounts.
security_options=json.loads(subprocess.check_output(['docker','info','--format','{{json .SecurityOptions}}']))
selinux_disabled=not pathlib.Path('/sys/fs/selinux/enforce').exists() and isinstance(security_options,list) and not any('selinux' in str(option).lower() for option in security_options)
def compatible_mount_hashes(mounts, selinux_disabled):
 if not selinux_disabled: return []
 indexes=[i for i,m in enumerate(mounts) if m.get('Type')=='volume' and m.get('Name') in {'devin-gateway_devin-gateway-auth','devin-gateway_devin-gateway-settings'} and m.get('Driver')=='local' and m.get('RW') is True and m.get('Mode') in {'z','rw'}]
 hashes=set()
 for modes in itertools.product(['z','rw'],repeat=len(indexes)):
  variant=[dict(m) for m in mounts]
  for i,mode in zip(indexes,modes): variant[i]['Mode']=mode
  for order in itertools.permutations(variant):
   hashes.add(hashlib.sha256(json.dumps(list(order),sort_keys=True).encode()).hexdigest())
 return sorted(hashes)
mounts_sha=hashlib.sha256(json.dumps(sorted(mounts,key=lambda m:m['Destination']),sort_keys=True).encode()).hexdigest()
mount_order_hashes=[hashlib.sha256(json.dumps(list(order),sort_keys=True).encode()).hexdigest() for order in itertools.permutations(mounts)]
mount_mode_hashes=compatible_mount_hashes(mounts,selinux_disabled)
digests={}
for m in mounts:
 if m['Type']!='volume': continue
 root=pathlib.Path(m['Source']); h=hashlib.sha256()
 assert root.is_dir() and not root.is_symlink()
 for p in sorted(root.rglob('*')):
  s=p.lstat(); assert not stat.S_ISLNK(s.st_mode)
  assert stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)
  h.update(json.dumps([str(p.relative_to(root)),stat.S_IMODE(s.st_mode),s.st_uid,s.st_gid],separators=(',',':')).encode())
  if p.is_file(): h.update(hashlib.sha256(p.read_bytes()).digest())
 digests[m['Name']]=h.hexdigest()
env=pathlib.Path('$RemoteDir/.env'); assert env.is_file() and not env.is_symlink()
head=subprocess.check_output(['git','-C','$RemoteDir','rev-parse','HEAD'],text=True).strip()
flag=subprocess.run(['docker','exec','devin-gateway-devin-gateway-1','sh','-c','test "'+chr(36)+'DEVIN_SWE_AUTONOMOUS_CONTINUATION" = 1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
compaction=subprocess.run(['docker','exec','devin-gateway-devin-gateway-1','sh','-c','test "'+chr(36)+'DEVIN_CROSS_PROVIDER_SKIP_COMPACTION" = 1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
print(json.dumps({'head':head,'envSha':hashlib.sha256(env.read_bytes()).hexdigest(),'volumesSha':hashlib.sha256(json.dumps(digests,sort_keys=True).encode()).hexdigest(),'mountsSha':mounts_sha,'mountOrderHashes':mount_order_hashes,'selinuxDisabled':selinux_disabled,'mountModeHashes':mount_mode_hashes,'mounts':mounts,'flagEnabled':flag,'compactionEnabled':compaction}))
"@
}
function Save-Extra($Value) {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $extraState -Encoding utf8
}
function Assert-PersistentSnapshot($Actual, $Saved) {
    if ($Actual.volumesSha -ne $Saved.volumesSha) { throw 'Persistent volume bytes/permissions changed (volumesSha mismatch)' }
    if ($Actual.mountsSha -ne $Saved.mountsSha -and $Actual.mountOrderHashes -notcontains $Saved.mountsSha) {
        if ($Actual.PSObject.Properties['selinuxDisabled'] -and $Actual.selinuxDisabled -eq $true -and $Actual.PSObject.Properties['mountModeHashes'] -and $Actual.mountModeHashes -contains $Saved.mountsSha) {
            Write-Host 'Mounts verified: only named-volume z/rw representation differs; SELinux is disabled and every other field matches.'
            return
        }
        throw 'Docker mount fields changed (mountsSha mismatch; array ordering excluded)'
    }
}
function Assert-BaselineDiagnostics {
    $null = Invoke-PrivatePython @"
import json,subprocess
c=json.loads(subprocess.check_output(['docker','inspect','devin-gateway-devin-gateway-1']))[0]
e=dict(v.split('=',1) for v in c['Config']['Env'] if '=' in v)
assert e.get('DEVIN_RESPONSES_SAFE_DIAGNOSTICS')=='1'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS')=='1'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_RETENTION')=='20'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_DIR')=='/app/logs/haiku-full-catalog-20261027'
assert e.get('DEVIN_RESPONSES_CATALOG_BISECTION') in [None,'0']
print(json.dumps({'baseline_diagnostics_verified':True}))
"@
}
function Invoke-CompleteRollback {
    Assert-DesktopStopped
    Invoke-Phase 'Rollback' @('-ApprovedBy','operator')
    $saved = Get-Content -LiteralPath $extraState -Raw | ConvertFrom-Json
    $after = Get-PrivateSnapshot
    if ($after.head -ne $baseline -or $after.envSha -ne $saved.envSha -or -not $after.flagEnabled -or -not $after.compactionEnabled) { throw 'Rollback source/environment/continuation verification failed; retain all backups' }
    Assert-PersistentSnapshot $after $saved
    Assert-BaselineDiagnostics
    $manifestData = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $image = [string]$manifestData.RunningImageId
    if ($image -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Invalid rollback image identity' }
    $null = Invoke-PrivatePython @"
import json,subprocess
c=json.loads(subprocess.check_output(['docker','inspect','devin-gateway-devin-gateway-1']))[0]
assert c['Image']=='$image'
print(json.dumps({'rollback_image_verified':True}))
"@
    Write-Host 'ROLLBACK VERIFIED: original source/image/environment and persistent data preserved.'
}

function Assert-FailedDeployRestored {
    # The inner operator restores source on build failure and owns automatic
    # rollback after cutover. Never recreate again merely because Deploy failed.
    $saved = Get-Content -LiteralPath $extraState -Raw | ConvertFrom-Json
    $after = Get-PrivateSnapshot
    if ($after.head -ne $baseline -or $after.envSha -ne $saved.envSha -or -not $after.flagEnabled -or -not $after.compactionEnabled) { throw 'Failed deployment restoration verification failed; retain backups and inspect before retrying' }
    Assert-PersistentSnapshot $after $saved
    Assert-BaselineDiagnostics
    Write-Host 'Failed deployment restoration verified without another container recreation.'
}

if ($ValidateOnly) {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($PSCommandPath,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Deployment script AST invalid' }
    $savedStateDir = $StateDir
    $StateDir = Join-Path ([IO.Path]::GetTempPath()) ('haiku-bisection-wrapper-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $StateDir | Out-Null
        New-GuardedOperatorCopy
        $generated = [IO.File]::ReadAllText((Join-Path $StateDir 'Invoke-DevinDeploy.guarded.ps1'))
        if ($generated -notmatch 'DEVIN_RESPONSES_CATALOG_BISECTION=1' -or $generated -notmatch 'DEVIN_RESPONSES_FULL_CATALOG_RETENTION=20' -or $generated -notmatch 'Codex reopened; cutover/rollback refused') { throw 'Generated deployment or rollback guards missing' }
    } finally {
        if (Test-Path -LiteralPath $StateDir) { Remove-Item -LiteralPath $StateDir -Recurse -Force }
        $StateDir = $savedStateDir
    }
    Write-Host 'OFFLINE VALIDATION PASSED: AST, operator parameters, generated cutover and rollback guards; no SSH or deployment.'
    exit 0
}
Assert-DesktopStopped
if ($Rollback) { New-GuardedOperatorCopy; Invoke-CompleteRollback; exit 0 }
if (Test-Path -LiteralPath $manifest) { throw 'Deployment manifest already exists. Retain it; use -Rollback or investigate before retrying.' }
if (Test-Path -LiteralPath $StateDir) { throw 'Deployment requires a fresh state directory; existing recovery evidence was not changed.' }
$localHead = & git -c "safe.directory=$repo" -C $repo rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $localHead -ne $commit) { throw 'Local HEAD differs from the committed deployment target' }
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $StateDir /inheritance:r /grant:r "${who}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict local deployment-state permissions' }
New-GuardedOperatorCopy
$deployAttempted = $false
$deployCompleted = $false
try {
    Invoke-Phase 'Preflight'
    $before = Get-PrivateSnapshot
    if ($before.head -ne $baseline) { throw 'Production baseline mismatch' }
    Assert-BaselineDiagnostics
    if (-not $before.flagEnabled -or -not $before.compactionEnabled) { throw 'Existing SWE continuation or compaction skip is not enabled; refusing to alter its configuration' }
    Save-Extra $before
    Invoke-Phase 'Backup'
    $m = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($m.BackupDir -notmatch ('^/home/' + [regex]::Escape(($SshTarget -split '@')[0]) + '/backups/devin-gateway-[0-9-]+$')) { throw 'Unexpected backup directory' }
    $null = Invoke-PrivatePython @"
import hashlib,json,pathlib,subprocess
d=pathlib.Path('$($m.BackupDir)')
for name in ['auth-volume.tar','settings-volume.tar']:
 subprocess.run(['tar','-tf',str(d/name)],check=True,stdout=subprocess.DEVNULL)
assert hashlib.sha256((d/'env.backup').read_bytes()).hexdigest()=='$($before.envSha)'
print(json.dumps({'backupVerified':True}))
"@
    Invoke-Phase 'Bundle'
    Invoke-Phase 'Transfer'
    Invoke-Phase 'ProxyCheck'
    Assert-DesktopStopped
    Assert-DesktopStopped
    $deployAttempted = $true
    Invoke-Phase 'Deploy' @('-ApprovedBy','operator','-CodexStopped')
    $deployCompleted = $true
    $check = Invoke-PrivatePython @"
import json,subprocess
c=json.loads(subprocess.check_output(['docker','inspect','devin-gateway-devin-gateway-1']))[0]
e=dict(v.split('=',1) for v in c['Config']['Env'] if '=' in v)
assert e.get('DEVIN_RESPONSES_CATALOG_BISECTION')=='1'
assert e.get('DEVIN_RESPONSES_SAFE_DIAGNOSTICS')=='1'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS')=='1'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_RETENTION')=='20'
assert e.get('DEVIN_RESPONSES_FULL_CATALOG_DIR')=='/app/logs/haiku-full-catalog-20261027'
print(json.dumps({'diagnostic_configuration_verified':True}))
"@
    $after = Get-PrivateSnapshot
    if ($after.head -ne $commit -or -not $after.flagEnabled -or -not $after.compactionEnabled -or $after.envSha -ne $before.envSha) { throw 'Deployed commit/environment/feature flag verification failed' }
    Assert-PersistentSnapshot $after $before
    Invoke-Phase 'ProxyCheck'
    Write-Host "DEPLOYMENT SUCCESS: $commit; health=ok; fallback_token=set; collapse=true; DEVIN_SWE_AUTONOMOUS_CONTINUATION=1."
    Write-Host "Accounts, credentials, settings, Tested data, .env and volume mounts verified unchanged. Rollback manifest: $manifest"
    Write-Host 'Existing Nginx configuration/secret retained; no NginxSecret onboarding step is needed.'
} catch {
    Write-Host 'DEPLOYMENT STOPPED. Keep Codex closed and retain the manifest/backups.'
    if ($deployAttempted) {
        try {
            if ($deployCompleted) { Invoke-CompleteRollback }
            else { Assert-FailedDeployRestored }
        }
        catch { Write-Host ("RECOVERY NOT VERIFIED: " + $_.Exception.Message + '. Retain backups; inspect before retrying or running rollback again.') }
    }
    $quote = { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }
    Write-Host ("Exact rollback command: pwsh -NoProfile -File " + (& $quote $PSCommandPath) + " -TargetCommit " + $commit + " -BundleRef " + (& $quote $BundleRef) + " -Rollback -StateDir " + (& $quote $StateDir) + " -SshTarget " + (& $quote $SshTarget) + " -SshKey " + (& $quote $SshKey) + " -RemoteDir " + (& $quote $RemoteDir) + " -GatewayHost " + (& $quote $GatewayHost) + " -NginxTarget " + (& $quote $NginxTarget) + " -NginxAddress " + (& $quote $NginxAddress))
    throw
}
