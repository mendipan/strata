$ErrorActionPreference = 'Stop'
$runnerScript = Join-Path $PSScriptRoot 'studio-agent-runner.js'
& node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Install Node 22 or newer before runner setup.' }
$runtime = (Read-Host 'Runtime selected in Settings (codex or claude)').ToLowerInvariant()
if ($runtime -notin @('codex', 'claude')) { throw 'Choose the runtime shown in Settings.' }
$runnerParent = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Strata'
$runnerDirectory = Join-Path $runnerParent ('AgentRunner-' + $runtime)
function New-PrivateDirectory([string]$path) {
  if (Test-Path -LiteralPath $path) { return } # Existing ACLs are never rewritten.
  $directory = [IO.Directory]::CreateDirectory($path)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $directory.FullName -AclObject $acl
}
New-PrivateDirectory $runnerParent
New-PrivateDirectory $runnerDirectory
if ((Test-Path -LiteralPath (Join-Path $runnerDirectory 'runner.json')) -or
    (Test-Path -LiteralPath (Join-Path $runnerDirectory 'pairing-pending.json'))) {
  throw 'Existing or unresolved pairing found. Start the existing runner using the README; do not pair over its journal.'
}
if ($runtime -eq 'claude') {
  & npm.cmd ci --prefix $PSScriptRoot --ignore-scripts --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'Pinned Claude SDK installation failed.' }
}
$runtimeArguments = @('--runtime', $runtime)
if ($runtime -eq 'codex') {
  $nativeBinary = Read-Host 'Absolute path to the reviewed native codex.exe (version 0.162.1)'
  & node $runnerScript --check-codex --codex-bin $nativeBinary
  if ($LASTEXITCODE -ne 0) { throw 'Codex preflight failed. No pairing code was consumed and no existing CLI was changed.' }
  Write-Host 'Schema preflight passed. This does not qualify MXC. Complete the README credential-free host checks before attended pairing or native turns.'
  $runtimeArguments += @('--codex-bin', $nativeBinary)
}
$studioOrigin = Read-Host 'Exact HTTPS Studio URL'
$pairingId = Read-Host 'Pairing ID shown in Settings'
$secureCode = Read-Host 'One-use pairing code' -AsSecureString
$codePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode)
try {
  $pairingCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($codePointer)
  $pairingCode | & node $runnerScript --state-dir $runnerDirectory --origin $studioOrigin --pairing-id $pairingId @runtimeArguments --code-stdin
  if ($LASTEXITCODE -ne 0) { throw 'Pairing failed. Inspect Studio before creating another code.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($codePointer)
  $pairingCode = $null
}
if ($runtime -eq 'claude') {
  $secureKey = Read-Host 'Claude API key (stored only on this machine)' -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    $apiKey | & node $runnerScript --state-dir $runnerDirectory --save-api-key --key-stdin
    if ($LASTEXITCODE -ne 0) { throw 'Local credential setup failed.' }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $apiKey = $null
  }
}
& node $runnerScript --state-dir $runnerDirectory --initialize
if ($LASTEXITCODE -ne 0) { throw 'Runner initialization failed. No task was submitted.' }
& node $runnerScript --state-dir $runnerDirectory
