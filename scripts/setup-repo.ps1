$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$repo = 'Smithey-Lab/Deepseek-Chat'
function Invoke-Gh { & gh @args; if ($LASTEXITCODE -ne 0) { throw "GitHub command failed: $($args[0])" } }
Invoke-Gh repo edit $repo --default-branch main --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false --delete-branch-on-merge=false --enable-issues --enable-wiki=false
$main = @{
  required_status_checks = @{ strict = $true; contexts = @('Quality', 'Windows installer') }
  enforce_admins = $true
  required_pull_request_reviews = @{ dismiss_stale_reviews = $true; require_code_owner_reviews = $false; required_approving_review_count = 0 }
  restrictions = $null
  required_linear_history = $true
  allow_force_pushes = $false
  allow_deletions = $false
  required_conversation_resolution = $true
}
$dev = @{
  required_status_checks = $null
  enforce_admins = $true
  required_pull_request_reviews = $null
  restrictions = $null
  required_linear_history = $true
  allow_force_pushes = $false
  allow_deletions = $false
}
foreach ($branch in @('main', 'dev')) {
  $settings = if ($branch -eq 'main') { $main } else { $dev }
  $settings | ConvertTo-Json -Depth 10 | gh api --method PUT "repos/$repo/branches/$branch/protection" --input - --silent
  if ($LASTEXITCODE -ne 0) { throw "Could not protect $branch." }
}
Invoke-Gh api --method PUT "repos/$repo/vulnerability-alerts" --silent
Invoke-Gh api --method PUT "repos/$repo/private-vulnerability-reporting" --silent
@{ security_and_analysis = @{ secret_scanning = @{ status = 'enabled' }; secret_scanning_push_protection = @{ status = 'enabled' } } } | ConvertTo-Json -Depth 5 | gh api --method PATCH "repos/$repo" --input - --silent
if ($LASTEXITCODE -ne 0) { throw 'Could not enable secret scanning.' }
Write-Host 'Repository settings and main/dev protections applied.'
