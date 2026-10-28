<# .SYNOPSIS
Checks staged changes for common private operator details before publication.
.DESCRIPTION
Prints paths and categories only, not matching content. This is a safeguard,
not a substitute for reviewing the staged diff and complete outgoing history.
#>
[CmdletBinding()]
param([switch]$StagedOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (& git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { throw 'Not inside a Git repository.' }
$files = @(& git diff --cached --name-only --diff-filter=ACMR)
if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate staged changes.' }
$rules = [ordered]@{
  'operator artifact' = '(^|/)(state-[^/]+|test-results)(/|$)|\.backup[^/]*$|\.bak$|(^|/)\.env(\..*)?$|(^|/)secrets/'
  'private address' = '(?<![\d.])(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})(?![\d.])'
  'personal path or login' = '(?i)[a-z]:[\\/]users[\\/](?!<|%)[^\\/\s]+[\\/]|(?:ssh|scp)\s+[^\s@]+@[^\s]+'
  'credential pattern' = '(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'
}
$hits = [System.Collections.Generic.List[string]]::new()
foreach ($file in $files) {
  if ($file -match $rules['operator artifact'] -and $file -ne '.env.example') { $hits.Add("${file}: operator artifact") }
  $body = & git show ":$file" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect staged file: $file" }
  $bodyText = $body -join "`n"
  foreach ($category in @('private address','personal path or login','credential pattern')) {
    if ($bodyText -match $rules[$category]) { $hits.Add("${file}: $category") }
  }
}
if (-not $StagedOnly) {
  $refs = @(& git for-each-ref --format='%(refname)' refs/remotes/origin)
  if ($LASTEXITCODE -ne 0 -or $refs.Count -eq 0) { throw 'No local origin references: fetch and verify the destination before checking outgoing history.' }
  $commits = @(& git log --format='%H' HEAD --not --remotes=origin)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate outgoing history.' }
  foreach ($commit in $commits) {
    if ($commit -notmatch '^[a-f0-9]{40}$') { throw 'Unexpected commit identifier.' }
    $patch = @(& git show --format= --no-ext-diff --no-color $commit --)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect outgoing commit.' }
    # Removed lines already belong to the parent; scan newly introduced text.
    $patchText = (@($patch | Where-Object { $_ -match '^\+[^+]' }) -join "`n")
    foreach ($category in @('private address','personal path or login','credential pattern')) {
      if ($patchText -match $rules[$category]) { $hits.Add("commit $($commit.Substring(0,12)): $category") }
    }
    $changedFiles = @(& git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r $commit)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect outgoing file names.' }
    foreach ($file in $changedFiles) {
      if ($file -match $rules['operator artifact'] -and $file -ne '.env.example') { $hits.Add("commit $($commit.Substring(0,12)): operator artifact") }
    }
    $authors = (& git show -s --format='%ae%n%ce' $commit) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect outgoing commit authors.' }
    if ($authors -match $rules['personal path or login']) { $hits.Add("commit $($commit.Substring(0,12)): personal author email") }
  }
}
if ($hits.Count) { $hits | Sort-Object -Unique | ForEach-Object { Write-Host $_ }; Write-Host 'Publication check failed. Review the staged files and outgoing history.'; exit 1 }
Write-Host "Publication check passed ($($files.Count) staged files). Review the destination, full diff and history manually."
