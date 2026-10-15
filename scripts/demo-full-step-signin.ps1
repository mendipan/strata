param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{32}$')]
  [string]$AccountId,
  [switch]$SignIn
)
$ErrorActionPreference = 'Stop'
$demoProjectRoot = Split-Path -Parent $PSScriptRoot
$demoCfCli = Join-Path $demoProjectRoot 'node_modules/cf/bin/cf'
$demoCfPackage = Join-Path $demoProjectRoot 'node_modules/cf/package.json'
if ((Get-Content -LiteralPath $demoCfPackage -Raw | ConvertFrom-Json).version -cne '1.0.0-beta.12') {
  throw 'Install the exact project lockfile before checking cf access.'
}
Push-Location -LiteralPath $demoProjectRoot
$demoPreviousAccount = $env:CLOUDFLARE_ACCOUNT_ID
try {
  $demoAuthOutput = & node $demoCfCli auth whoami
  if ($LASTEXITCODE -ne 0) { throw 'cf authentication check did not settle. No login or demo was started.' }
  $demoAuth = ($demoAuthOutput -join "`n") | ConvertFrom-Json
  if ($demoAuth.authenticated -ne $true) {
    if (-not $SignIn) { throw 'cf needs its own Cloudflare sign-in. Re-run this script with -SignIn when ready to approve the browser page.' }
    & node $demoCfCli auth login --scopes user:read account:read workers-scripts.read offline
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare sign-in was not completed. No demo or resource was created.' }
    $demoAuthOutput = & node $demoCfCli auth whoami
    if ($LASTEXITCODE -ne 0 -or (($demoAuthOutput -join "`n") | ConvertFrom-Json).authenticated -ne $true) {
      throw 'cf authentication remains unverified.'
    }
  }
  $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
  # Exact account and one page. No Worker, Workflow, repository or grant creation.
  & node $demoCfCli workflows list --page 1 --per-page 1
  if ($LASTEXITCODE -ne 0) { throw 'Read access to the exact Cloudflare account remains unverified.' }
  Write-Output 'cf sign-in and exact-account Workflow read succeeded. No demo was started; full-step payload retrieval still needs an approved live run.'
}
finally {
  $env:CLOUDFLARE_ACCOUNT_ID = $demoPreviousAccount
  Pop-Location
}
