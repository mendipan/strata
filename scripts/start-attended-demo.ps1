[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SignIn,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $PSScriptRoot
function Invoke-DemoCloudflareSignIn {
  Write-Host 'Approve the supported Cloudflare browser pages. No grant or resource exists from this preparation attempt.'
  & node node_modules/wrangler/bin/wrangler.js login
  if ($LASTEXITCODE -ne 0) { throw 'Wrangler sign-in failed. No run started.' }
  & node node_modules/cf/bin/cf auth login --scopes user:read account:read workers-scripts.read offline
  if ($LASTEXITCODE -ne 0) { throw 'cf sign-in failed. No run started.' }
}
Push-Location -LiteralPath $demoRoot
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node 22 or later, then run this script again.' }
  if (-not (Test-Path -LiteralPath 'node_modules/typescript/bin/tsc')) {
    throw 'Project dependencies are missing. Run npm ci in this directory, then run this script again.'
  }
  Write-Host "`nSTRATA ATTENDED DEMO - no grant or paid generation during preparation" -ForegroundColor Cyan
  Write-Host 'Keep this terminal open. The browser is for progress and the two decisions.'
  Write-Host 'Building the exact local source before review...'
  & node node_modules/typescript/bin/tsc --noEmit false --outDir dist --rootDir .
  if ($LASTEXITCODE -ne 0) { throw 'Build failed. No run started.' }
  & node dist/scripts/integrated-demo-operator.js check-cli
  if ($LASTEXITCODE -ne 0) { throw 'Codex subscription access is unverified. Use codex login in your normal terminal, then rerun. No API billing fallback.' }
  if ($SignIn) {
    Write-Host 'Cloudflare has two CLI sign-ins: Wrangler manages resources; cf reads complete Workflow steps.'
    Invoke-DemoCloudflareSignIn
  }
  $demoMode = if ($CheckOnly) { 'check' } else { 'start' }
  $demoArguments = @('dist/scripts/integrated-demo-guided.js', $demoMode)
  if ($NoBrowser) { $demoArguments += '--no-browser' }
  for ($demoAttempt = 1; $demoAttempt -le 3; $demoAttempt++) {
    & node @demoArguments
    $demoExitCode = $LASTEXITCODE
    if ($demoExitCode -eq 0) { break }
    # Only these dedicated BEFORE-GRANT exits permit another preparation.
    # A live failure always exits 7 and cannot enter this menu.
    if ($CheckOnly -or $demoAttempt -eq 3 -or $demoExitCode -notin @(10, 11)) {
      throw 'Stopped. Read the boundary and evidence path above. No automatic retry occurred; preserve any grant/journal.'
    }
    Write-Host 'Access check failed BEFORE a grant or deployment. You may explicitly repeat preparation.' -ForegroundColor Yellow
    $demoAccessChoice = Read-Host 'R = retry read-only checks; S = Cloudflare sign-in then recheck; anything else = stop'
    if ($demoAccessChoice -ieq 'S') { Invoke-DemoCloudflareSignIn }
    elseif ($demoAccessChoice -ine 'R') { throw 'Preparation stopped. No grant or demo resources created.' }
  }
}
finally { Pop-Location }
