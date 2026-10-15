[CmdletBinding()]
param([switch]$NoBrowser, [switch]$Replay)
$ErrorActionPreference = 'Stop'
$demoBrowserRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $demoBrowserRoot
try {
  & node node_modules/typescript/bin/tsc --noEmit false --outDir dist --rootDir .
  if ($LASTEXITCODE -ne 0) { throw 'Build failed; no demo started.' }
  $demoBrowserArguments = @('dist/scripts/integrated-demo-browser.js')
  if ($NoBrowser) { $demoBrowserArguments += '--no-browser' }
  if ($Replay) { $demoBrowserArguments += '--replay' }
  & node @demoBrowserArguments
  if ($LASTEXITCODE -ne 0) { throw 'Browser controller stopped. Preserve any active run evidence shown above.' }
}
finally { Pop-Location }
