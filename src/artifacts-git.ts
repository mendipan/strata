import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { canonical, digest, fail } from './model.js';

const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');
const pkt = (s: string) => Buffer.from((Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s);
export function packetLines(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes), result: string[] = [];
  for (let offset = 0; offset < buffer.length;) {
    const raw = buffer.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/i.test(raw)) fail('ARTIFACT_PROTOCOL', 9, 'Invalid Git packet header.');
    const length = parseInt(raw, 16); offset += 4;
    if (length === 0) continue;
    if (length < 4 || offset + length - 4 > buffer.length) fail('ARTIFACT_PROTOCOL', 9, 'Truncated Git packet.');
    result.push(buffer.subarray(offset, offset + length - 4).toString()); offset += length - 4;
  }
  return result;
}
export type GitBundle = { branch: string; commit: string; pack: Buffer; hashes: string[] };
export const artifactBatchBranch = (hashes: string[]) => 'refs/heads/strata/artifacts/' + digest([...hashes].sort());
export function artifactBundle(objects: { hash: string; bytes: string | Uint8Array; path?: string }[]): GitBundle {
  const sorted = [...objects].sort((a, b) => (a.path ?? a.hash + '.json').localeCompare(b.path ?? b.hash + '.json'));
  const hashes = sorted.map(o => o.hash), binary = sorted.some(o => o.path?.endsWith('.bin'));
  const addresses = sorted.map(o => ({ hash: o.hash, path: o.path ?? o.hash + '.json' }));
  const batch = binary ? digest(addresses) : digest(hashes);
  const manifest = binary ? { version: 2, algorithm: 'sha256', objects: addresses } : { version: 1, algorithm: 'sha256', hashes };
  const files = [...sorted.map(o => ({ name: o.path ?? o.hash + '.json', body: typeof o.bytes === 'string' ? Buffer.from(o.bytes, 'utf8') : Buffer.from(o.bytes) })), { name: 'manifest.json', body: Buffer.from(canonical(manifest)) }].sort((a, b) => a.name.localeCompare(b.name));
  const items: { kind: number; body: Buffer; hash: string }[] = [];
  const add = (type: string, kind: number, body: Buffer) => {
    const hash = sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
    items.push({ kind, body, hash }); return hash;
  };
  const tree = Buffer.concat(files.map(file => Buffer.concat([Buffer.from(`100644 ${file.name}\0`), Buffer.from(add('blob', 3, file.body), 'hex')])));
  const treeHash = add('tree', 2, tree);
  const commit = add('commit', 1, Buffer.from(`tree ${treeHash}\nauthor Strata <local@strata.invalid> 0 +0000\ncommitter Strata <local@strata.invalid> 0 +0000\n\nStrata immutable artifact batch ${batch}\n`));
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(items.length, 8);
  const compressed = items.map(({ kind, body }) => {
    const bytes: number[] = []; let remaining = Math.floor(body.length / 16), first = (kind << 4) | (body.length & 15);
    bytes.push(first | (remaining ? 128 : 0));
    while (remaining) { const value = remaining & 127; remaining = Math.floor(remaining / 128); bytes.push(value | (remaining ? 128 : 0)); }
    return Buffer.concat([Buffer.from(bytes), deflateSync(body)]);
  });
  const prefix = Buffer.concat([header, ...compressed]);
  return { branch: binary ? 'refs/heads/strata/artifacts/' + batch : artifactBatchBranch(hashes), commit, pack: Buffer.concat([prefix, Buffer.from(sha1(prefix), 'hex')]), hashes };
}
export type FetchTransport = (request: Request) => Promise<Response>;
export const MAX_GIT_RESPONSE_BYTES = 65536;
async function responsePackets(response: Response) {
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  if (!reader) fail('ARTIFACT_PROTOCOL', 9, 'Git response has no body.');
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_GIT_RESPONSE_BYTES) fail('ARTIFACT_PROTOCOL', 9, 'Git response exceeds its reserved byte limit.'); chunks.push(next.value); }
  } finally { await reader.cancel(); }
  return packetLines(Buffer.concat(chunks));
}

// Minimal Git smart-HTTP receive-pack client: creates one deterministic orphan branch
// per immutable batch. No clone, native git, force push, default-branch update or retry.
export async function pushArtifactBundle(remote: string, token: string, bundle: GitBundle, transport: FetchTransport, signal: AbortSignal): Promise<{ reused: boolean }> {
  const auth = { authorization: 'Bearer ' + token };
  // Use manual for runtime portability and to prevent forwarding credentials.
  // Any redirect is rejected below as a non-success response, never followed.
  const discovery = await transport(new Request(remote + '/info/refs?service=git-receive-pack', { headers: auth, signal, redirect: 'manual' }));
  if (!discovery.ok) fail('ARTIFACT_PROTOCOL', 9, 'Git reference discovery failed.');
  const lines = await responsePackets(discovery);
  const refs = lines.filter(l => !l.startsWith('#'));
  const first = refs[0] ?? '', capabilities = first.split('\0')[1]?.trim().split(' ') ?? [];
  if (!capabilities.includes('report-status')) fail('ARTIFACT_PROTOCOL', 9, 'Git server does not advertise report-status.');
  const existing = refs.find(l => l.split('\0')[0].trim().split(' ')[1] === bundle.branch);
  if (existing) {
    if (existing.slice(0, 40) !== bundle.commit) fail('ARTIFACT_COLLISION', 9, 'Immutable artifact branch already has different content.');
    return { reused: true };
  }
  const command = pkt(`${'0'.repeat(40)} ${bundle.commit} ${bundle.branch}\0report-status\n`);
  const payload = Buffer.concat([command, Buffer.from('0000'), bundle.pack]);
  const response = await transport(new Request(remote + '/git-receive-pack', { method: 'POST', headers: { ...auth, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: new Uint8Array(payload), signal, redirect: 'manual' }));
  if (!response.ok) fail('ARTIFACT_PROTOCOL', 9, 'Git batch publication failed; no automatic retry was attempted.');
  const result = (await responsePackets(response)).map(s => s.trim());
  if (!result.includes('unpack ok') || !result.includes('ok ' + bundle.branch) || result.some(l => l.startsWith('ng '))) fail('ARTIFACT_PROTOCOL', 9, 'Git server did not confirm batch publication.');
  return { reused: false };
}
