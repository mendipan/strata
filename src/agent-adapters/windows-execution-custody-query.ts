import { execFile } from 'node:child_process';

// Internal, fixed read-only helper. Caller paths are JSON on stdin, never code,
// command-line switches, environment variables, or PowerShell interpolation.
export interface WindowsCustodyRequest { version: 1; nonce: string; paths: string[] }
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const windowsCustodyOutputLimit = 256 * 1024;
export const windowsCustodyMaxPaths = 64;
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
  $null = Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class StrataCustodyQuery {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
      WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameSize,
    out uint serial, out uint componentSize, out uint flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(SafeFileHandle handle, uint type, uint information,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  public sealed class Ace {
    public int type, flags; public uint mask; public string sid; public bool callback;
  }
  public sealed class Item {
    public string requestedPath, finalPath, fileId, ownerSid;
    public uint volume, attributes, links;
    public int revision, control, aclRevision;
    public Ace[] aces;
  }
  static void Fail() { throw new InvalidOperationException(); }
  public static Item Read(string path) {
    string root = Path.GetPathRoot(path);
    uint serial, componentSize, volumeFlags;
    StringBuilder fs = new StringBuilder(32);
    if (GetDriveTypeW(root) != 3 || !GetVolumeInformationW(root, null, 0,
        out serial, out componentSize, out volumeFlags, fs, 32) || fs.ToString() != "NTFS") Fail();
    // Include every ancestor in the reparse fence, including types that Node's
    // symlink test may not recognize. This does not attest ancestor ACL privacy.
    for (string ancestor = path; ancestor != null; ancestor = Path.GetDirectoryName(ancestor)) {
      uint attributes = GetFileAttributesW(ancestor);
      if (attributes == 0xffffffff || (attributes & 0x400) != 0) Fail();
      if (ancestor == root) break;
    }
    // READ_CONTROL | FILE_READ_ATTRIBUTES; no write/security access, privilege
    // adjustment, content read, or security-setting API. Open the reparse point
    // itself, then refuse it rather than following it.
    using (SafeFileHandle handle = CreateFileW(path, 0x20080, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) Fail();
      FileInfo info;
      StringBuilder final = new StringBuilder(32768);
      if (!GetFileInformationByHandle(handle, out info)) Fail();
      uint length = GetFinalPathNameByHandleW(handle, final, 32768, 0);
      if (length == 0 || length >= 32768) Fail();
      IntPtr owner, group, dacl, sacl, descriptor;
      if (GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor) != 0) Fail();
      try {
        uint size = GetSecurityDescriptorLength(descriptor);
        if (size < 20 || size > 65536) Fail();
        byte[] bytes = new byte[size]; Marshal.Copy(descriptor, bytes, 0, (int)size);
        RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
        if (security.Owner == null || security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count > 128) Fail();
        List<Ace> aces = new List<Ace>();
        foreach (GenericAce ace in security.DiscretionaryAcl) {
          KnownAce known = ace as KnownAce;
          CommonAce common = ace as CommonAce;
          aces.Add(new Ace { type = (int)ace.AceType, flags = (int)ace.AceFlags,
            mask = known == null ? 0 : unchecked((uint)known.AccessMask),
            sid = known == null ? "S-1-0-0" : known.SecurityIdentifier.Value,
            callback = common == null || common.IsCallback });
        }
        return new Item { requestedPath = path, finalPath = final.ToString(),
          fileId = info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8"),
          volume = info.Volume, attributes = info.Attributes, links = info.Links,
          ownerSid = security.Owner.Value, revision = bytes[0], control = (int)security.ControlFlags,
          aclRevision = security.DiscretionaryAcl.Revision, aces = aces.ToArray() };
      } finally { LocalFree(descriptor); }
    }
  }
}
'@
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 131072) { exit 1 }
  $request = ConvertFrom-Json -InputObject $inputText
  if ($request.version -ne 1 -or $request.paths.Count -lt 1 -or $request.paths.Count -gt ${windowsCustodyMaxPaths}) { exit 1 }
  $items = @($request.paths | ForEach-Object { [StrataCustodyQuery]::Read([string]$_) })
  $result = @{ version = 1; nonce = $request.nonce;
    processSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; items = $items }
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
} catch { exit 1 }
`;
const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

/** Bounded subprocess and response. No raw helper failure is exposed. */
export function queryWindowsCustody(request: WindowsCustodyRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      { windowsHide: true, timeout: 15000, maxBuffer: windowsCustodyOutputLimit, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error || stderr.length || stdout.length > windowsCustodyOutputLimit)
          reject(new Error('Windows custody metadata query unavailable.'));
        else resolve(stdout);
      });
    child.stdin?.on('error', () => {}); // A closed helper is handled by execFile.
    child.stdin?.end(JSON.stringify(request));
  });
}
