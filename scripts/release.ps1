param([string]$Version)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not $Version) {
  $latest = gh release view --repo Smithey-Lab/Deepseek-Chat --json tagName --jq .tagName 2>$null
  if ($LASTEXITCODE -eq 0 -and $latest -match '^v(\d+)\.(\d+)\.(\d+)$') { $Version = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)" }
  else { throw 'Pass -Version x.y.z explicitly for the first release or if the latest release cannot be read.' }
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Use a stable x.y.z version.' }
gh workflow run release.yml --repo Smithey-Lab/Deepseek-Chat --ref main -f "version=$Version"
if ($LASTEXITCODE -ne 0) { throw 'Could not start release workflow.' }
Write-Host "Release $Version requested from main. Follow progress in GitHub Actions."
