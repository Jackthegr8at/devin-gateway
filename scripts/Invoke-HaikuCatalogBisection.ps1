<#
.SYNOPSIS
Control an explicitly targeted, single-use Haiku catalog diagnostic.
.DESCRIPTION
No deployment or restart. Run only after the separately approved diagnostic deployment.
The next eligible Haiku High request consumes the local one-shot arm.
No prompt, schema, credential, or tool argument is persisted by this controller.
#>
[CmdletBinding()]
param(
 [ValidateSet('Start','Status','Stop','Retry','Extend')][string]$Action = 'Status',
 [ValidateSet('Auto','Pass','Fail')][string]$Result,
 [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'DevinGateway\haiku-catalog-bisection'),
 [ValidateRange(1,30)][int]$MaxRequests = 12,
 [ValidateRange(30,600)][int]$ArmSeconds = 180,
 [string]$SshTarget = $env:DEVIN_OPERATOR_SSH_TARGET,
 [string]$SshKey = $env:DEVIN_OPERATOR_SSH_KEY,
 [string]$RemoteDir = $env:DEVIN_OPERATOR_REMOTE_DIR,
 [string]$LocalTestRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($LocalTestRoot -and -not $RemoteDir) { $RemoteDir = '/example/gateway' }
if (-not $LocalTestRoot -and (-not $SshTarget -or -not $SshKey -or -not $RemoteDir)) { throw 'Set DEVIN_OPERATOR_SSH_TARGET and DEVIN_OPERATOR_SSH_KEY, or pass -SshTarget and -SshKey.' }
if (-not $LocalTestRoot -and $SshTarget -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$' -or $RemoteDir -notmatch '^/[A-Za-z0-9/_-]+$') { throw 'Unsafe SSH target or remote directory.' }
$statePath=Join-Path $StateDir 'state.json'
[IO.Directory]::CreateDirectory($StateDir) | Out-Null
$lockPath=Join-Path $StateDir 'controller.lock'
try { $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { throw 'Another controller is active.' }
function Control($payload) {
 $json=$payload | ConvertTo-Json -Depth 10 -Compress
 if ($LocalTestRoot) {
  $prevDir=$env:DEVIN_RESPONSES_CATALOG_BISECTION_DIR; $prevLog=$env:DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH
  try { $env:DEVIN_RESPONSES_CATALOG_BISECTION_DIR=Join-Path $LocalTestRoot 'arms'; $env:DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH=Join-Path $LocalTestRoot 'safe.jsonl'; $out=$json | & bun (Join-Path $PSScriptRoot '..\src\cli\catalog-bisection-control.ts') }
  finally { $env:DEVIN_RESPONSES_CATALOG_BISECTION_DIR=$prevDir; $env:DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH=$prevLog }
 } else {
  $remote="cd $RemoteDir && sudo -n docker compose exec -T -u gateway devin-gateway bun /app/src/cli/catalog-bisection-control.ts"
  $out=$json | & ssh -i $SshKey -o BatchMode=yes -o ConnectTimeout=10 $SshTarget $remote
 }
 if ($LASTEXITCODE -ne 0 -or @($out).Count -ne 1) { throw 'Gateway control failed; state was not advanced.' }
 return ($out | ConvertFrom-Json -AsHashtable)
}
function Save($s) { $tmp=Join-Path $StateDir ('.state-'+[guid]::NewGuid().ToString('N')+'.tmp'); try { [IO.File]::WriteAllText($tmp,($s | ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false)); [IO.File]::Move($tmp,$statePath,$true) } finally { if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force} } }
function Arm($s,[string]$selection) {
 if($s.used -ge $s.maxRequests){$s.phase='budget_exhausted';$s.pending=$null;return}
 $id=[guid]::NewGuid().ToString('N');$expires=[DateTimeOffset]::UtcNow.AddSeconds($ArmSeconds).ToUnixTimeMilliseconds()
 $a=@{id=$id;expiresAt=$expires;selection=$selection;requestSha256=$(if($selection -eq 'first-half'){$null}else{$s.requestSha256})}
 # Save intent first. A failed SSH call leaves an explicit pending intent, never an implicit rearm.
 $s.pending=@{id=$id;selection=$selection;expiresAt=$expires}; Save $s
 Control @{op='arm';arm=$a} | Out-Null; $s.used++; Save $s
}
function Show($s) { [pscustomobject]@{phase=$s.phase;requests_armed=$s.used;budget=$s.maxRequests;current_range=if($null -ne $s.start){"$($s.start)-$($s.end)"}else{$null};pending_arm=if($s.pending){$s.pending.id}else{$null};selection=if($s.pending){$s.pending.selection}else{$null};expires_utc=if($s.pending){[DateTimeOffset]::FromUnixTimeMilliseconds($s.pending.expiresAt).UtcDateTime}else{$null};candidate=if($s.phase -eq 'candidate'){$s.start}else{$null};last_request=if($s.history.Count){$s.history[-1].requestId}else{$null};note=$s.note} | Format-List }
try {
 if($Action -eq 'Start') {
  if($Result){throw 'Start does not accept Result.'};if(Test-Path -LiteralPath $statePath){throw 'State already exists; retain evidence and use a fresh StateDir.'}
  $s=@{phase='initial_left';contextFingerprintVersion=2;used=0;maxRequests=$MaxRequests;pending=$null;catalogSha256=$null;requestSha256=$null;start=$null;end=$null;left=$null;history=@();note='Awaiting the first half of the incoming catalog.'}
  Save $s;Arm $s 'first-half';Show $s;return
 }
 if($Action -eq 'Stop') {Control @{op='stop'} | Out-Null;if(Test-Path -LiteralPath $statePath){$s=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable;$s.pending=$null;$s.phase='stopped';$s.note='Filtering disarmed; an already claimed request may still be in flight.';Save $s;Show $s};return}
 if(!(Test-Path -LiteralPath $statePath)){throw 'No session. Use -Action Start with a fresh StateDir.'}
 $s=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
 if($Action -eq 'Extend') {
  if($s.phase -ne 'budget_exhausted' -or
     $s.pending -or
     $s.used -ne 12 -or
     $s.start -ne 17 -or
     $s.end -ne 21 -or
     $MaxRequests -le $s.used) {
   throw 'Unexpected bisection state; no changes made.'
  }
  $s.maxRequests=$MaxRequests
  $s.phase='left'
  $s.left=$null
  $s.note='Continuing remaining candidate range.'
  $mid=[int][math]::Floor(($s.start+$s.end)/2)
  Arm $s "keep:$($s.catalogSha256):$($s.start)-$mid"
  Save $s
  Show $s
  return
 }
 if($Action -eq 'Retry') {
  if(!$s.ContainsKey('contextFingerprintVersion') -or $s.contextFingerprintVersion -ne 2){throw 'Legacy fingerprint cannot be migrated without the original request; preserve this state and start a new bisection.'}
  if($Result -or !$s.pending){throw 'Retry requires one pending arm and no Result.'}
  $prior=$s.pending; $read=Control @{op='read';id=$prior.id};$record=$read.record
  if($record) {
   if($record.context_mismatch -ne $true -or $record.failure_classification -ne 'gateway_conversion_error' -or $record.stream_opened -ne $false -or @($record.http_statuses).Count -ne 0 -or $record.terminal_status -ne 'failed' -or $record.catalog_sha256 -ne $s.catalogSha256){throw 'Retry requires a correlated, locally rejected context mismatch with no upstream connection.'}
  } else {
   if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $prior.expiresAt){throw 'Pending arm has not expired and has no finalized rejection.'}
   Control @{op='clear-expired';id=$prior.id} | Out-Null
  }
  $s.note='Retrying the same selection; prior results preserved.';Arm $s $prior.selection;Save $s;Show $s;return
 }
 if(!$Result){Show $s;return}
 if(!$s.ContainsKey('contextFingerprintVersion') -or $s.contextFingerprintVersion -ne 2){throw 'Legacy fingerprint cannot be migrated without the original request; preserve this state and start a new bisection.'}
 if(!$s.pending){throw 'No pending armed request.'}
 $read=Control @{op='read';id=$s.pending.id};$record=$read.record
 if(!$record){throw 'No matching finalized safe diagnostic record; do not infer an outcome or rearm.'}
 if($record.tool_calls -ne 0 -or $record.upstream_tool_calls -ne 0 -or $record.request_id -notmatch '^[A-Za-z0-9_-]+$' -or $record.catalog_sha256 -notmatch '^[a-f0-9]{64}$' -or $record.request_sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Unsafe or incomplete record; stopped without advancing.'}
 if($record.stream_opened -ne $true -or @($record.http_statuses | Where-Object { $_.stage -eq 'auth' -and $_.status -eq 200 }).Count -ne 1 -or @($record.http_statuses | Where-Object { $_.stage -eq 'chat' -and $_.status -eq 200 }).Count -ne 1){throw 'Missing or unexpected upstream status; stopped without advancing.'}
 if($s.phase -ne 'initial_left' -and ($record.catalog_sha256 -ne $s.catalogSha256 -or $record.request_sha256 -ne $s.requestSha256)){throw 'Catalog or request context drift; stopped without advancing.'}
 if($s.pending.selection -eq 'first-half') { $half=[int][math]::Ceiling($record.original_count/2);if($record.original_count -lt 2 -or $record.original_count -gt 512 -or $record.mode -ne 'keep' -or (($record.ordinals | ConvertTo-Json -Compress) -ne (@(0..($half-1)) | ConvertTo-Json -Compress))){throw 'First-half catalog record is incomplete.'} }
 else { if($s.pending.selection -notmatch '^keep:[a-f0-9]{64}:(\d+)-(\d+)$'){throw 'Invalid pending selection.'};$first=[int]$Matches[1];$last=[int]$Matches[2];$expected=@($first..$last);if($record.mode -ne 'keep' -or (($record.ordinals | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress))){throw 'Selected ordinals differ from the armed selection.'} }
 if($Result -eq 'Auto') { if($record.terminal_status -eq 'completed'){$outcome='Pass'} elseif($record.terminal_status -eq 'failed' -and $record.connect_error_code -eq 'invalid_argument'){$outcome='Fail'} else {throw 'Outcome is not classifiable; inspect sanitized evidence. Do not rearm.'} } else { $outcome=$Result; if(($Result -eq 'Pass' -and $record.terminal_status -ne 'completed') -or ($Result -eq 'Fail' -and ($record.terminal_status -ne 'failed' -or $record.connect_error_code -ne 'invalid_argument'))){throw 'Reported outcome does not match the sanitized record.'} }
 $s.history += @{requestId=$record.request_id;armId=$s.pending.id;selection=$s.pending.selection;outcome=$outcome}
 $s.pending=$null;Save $s
 if($s.phase -eq 'initial_left') {
  $s.catalogSha256=$record.catalog_sha256;$s.requestSha256=$record.request_sha256;$s.start=0;$s.end=$record.original_count-1;$s.left=$outcome;$s.phase='right';$s.note='Testing complementary half.'
 } elseif($s.phase -eq 'left') { $s.left=$outcome;$s.phase='right';$s.note='Testing complementary half.' }
 elseif($s.phase -eq 'right') {
  if($s.left -eq $outcome) { $s.phase='inconclusive';$s.note=if($outcome -eq 'Pass'){'Both halves passed; interaction or context cause remains possible.'}else{'Both halves failed; multiple causes or interactions remain possible.'};Save $s;Show $s;return }
  $mid=[int][math]::Floor(($s.start+$s.end)/2);if($s.left -eq 'Fail'){$s.end=$mid}else{$s.start=$mid+1}
  if($s.start -eq $s.end){$s.phase='candidate';$s.note='Single failing candidate, not proof of a unique root cause.';Save $s;Show $s;return}
  $s.phase='left';$s.left=$null;$s.note='Testing first half of failing range.'
 } else {throw 'Session is not accepting results.'}
 $mid=[int][math]::Floor(($s.start+$s.end)/2)
 if($s.phase -eq 'left'){$first=$s.start;$last=$mid}else{$first=$mid+1;$last=$s.end}
 Arm $s "keep:$($s.catalogSha256):$first-$last";Save $s;Show $s
} finally { $lock.Dispose() }
