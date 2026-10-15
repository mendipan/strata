import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Test-only creation of NEW disposable objects. No Set-Acl/icacls, token or
// privilege changes, ownership transfer, or ACL edits to any existing object.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  if ([IO.File]::Exists($request.path) -or [IO.Directory]::Exists($request.path)) { exit 1 }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $allow = [Security.AccessControl.AccessControlType]::Allow
  if ($request.kind -eq 'directory') {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $security = [Security.AccessControl.FileSecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,
    [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [Security.AccessControl.PropagationFlags]::None, $allow))
  if ($request.unsafe) {
    $propagation = [Security.AccessControl.PropagationFlags]::None
    if ($request.inheritOnly) { $propagation = [Security.AccessControl.PropagationFlags]::InheritOnly }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [Security.AccessControl.FileSystemRights]::Read, $inherit, $propagation, $allow))
  }
  if ($request.kind -eq 'directory') {
    $null = [IO.Directory]::CreateDirectory([string]$request.path, $security)
  } else {
    $stream = [IO.FileStream]::new([string]$request.path, [IO.FileMode]::CreateNew,
      [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::ReadWrite,
      4096, [IO.FileOptions]::None, $security)
    $stream.Dispose()
  }
} catch { exit 1 }
`;
export function createWindowsCustodyFixture(root: string, filename: string,
  kind: 'directory' | 'file' = 'directory', unsafe = false, inheritOnly = false) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path: filename, kind, unsafe, inheritOnly }), windowsHide: true,
      timeout: 15000, maxBuffer: 16384, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'Disposable Windows fixture creation unavailable.');
  assert.equal(result.status, 0, 'Disposable Windows fixture creation refused; do not alter an existing ACL.');
  assert.equal(result.stderr, '');
}
