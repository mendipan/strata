import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT, CloudflareArtifactsAdapter, type ArtifactRepository, type ArtifactsNamespace } from '../src/artifacts.js';
import { packetLines } from '../src/artifacts-git.js';
import { RunBudget } from '../src/budget.js';
import { bytesDigest } from '../src/model.js';
const hash = (body: Uint8Array) => createHash('sha1').update(body).digest('hex');
const packet = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
export const budget = (operations = 100, bytes = 4 * 1024 * 1024) => new RunBudget({ operations, bytes, attempts: 1000, input_tokens: 0, output_tokens: 0, duration_ms: 60000 });
// Strict mock reads the actual pack and checks Git/SHA-256 bytes, not scripted success.
export class StrictArtifacts implements ArtifactsNamespace {
  refs = new Map<string, string>(); files = new Map<string, Map<string, Uint8Array>>();
  calls: string[] = []; pushes = 0; disposed = 0; revoked = 0; openHandles = 0;
  failPush = false; loseResponse = false; loseTokenResponse = false; corruptRead = false; missingRead = false; wrongRemote = false; cleanupFailure = false;
  async get(name: string): Promise<ArtifactRepository> {
    assert.equal(name, 'strata-smoke'); this.calls.push('get'); this.openHandles++;
    let disposed = false;
    return {
      info: async () => { this.calls.push('info'); return { remote: this.wrongRemote ? 'https://example.com/credential-sink' : 'https://account.artifacts.cloudflare.net/git/default/strata-smoke.git' }; },
      createToken: async (mode, ttl) => { assert.equal(mode, 'write'); assert.equal(ttl, 60); this.calls.push('createToken');
        const value = { plaintext: 'mock-only-token?expires=fixture', expiresAt: 'fixture' };
        if (this.loseTokenResponse) { this.loseTokenResponse = false; throw new Error('mock-only token response lost'); } return value; },
      revokeToken: async token => { assert.equal(token, 'mock-only-token?expires=fixture'); this.calls.push('revokeToken'); this.revoked++; if (this.cleanupFailure) throw new Error('fixture cleanup failure'); return true; },
      readFile: async ({ ref, path }) => {
        this.calls.push('readFile'); assert.match(ref, /^([a-f0-9]{40}|refs\/heads\/strata\/artifacts\/[a-f0-9]{64})$/); assert.match(path, /^[a-f0-9]{64}\.(json|bin)$/);
        const content = this.files.get(this.refs.get(ref) ?? ref)?.get(path);
        return this.missingRead || content === undefined ? null : new Blob([this.corruptRead ? 'bad' : new Uint8Array(content)]);
      },
      [Symbol.dispose]: () => { assert.equal(disposed, false, 'Each acquired handle is disposed exactly once.'); disposed = true; this.calls.push('dispose'); this.disposed++; this.openHandles--; }
    };
  }
  transport = async (request: Request): Promise<Response> => {
    assert.equal(request.headers.get('authorization'), 'Bearer mock-only-token?expires=fixture');
    assert.equal(request.redirect, 'manual'); const url = new URL(request.url);
    assert.equal(url.origin, 'https://account.artifacts.cloudflare.net');
    if (request.method === 'GET') {
      assert.equal(url.pathname, '/git/default/strata-smoke.git/info/refs'); assert.equal(url.search, '?service=git-receive-pack'); this.calls.push('discovery');
      const refs = [...this.refs];
      if (!refs.length) refs.push(['capabilities^{}', '0'.repeat(40)]);
      return new Response(packet('# service=git-receive-pack\n') + '0000' + refs.map(([ref, oid], i) => packet(`${oid} ${ref}${i ? '' : '\0report-status'}\n`)).join('') + '0000');
    }
    assert.equal(request.method, 'POST'); assert.equal(url.pathname, '/git/default/strata-smoke.git/git-receive-pack'); assert.equal(url.search, '');
    assert.equal(request.headers.get('content-type'), 'application/x-git-receive-pack-request'); this.calls.push('push'); this.pushes++;
    if (this.failPush) return new Response('failure', { status: 500 });
    const payload = Buffer.from(await request.arrayBuffer()), length = parseInt(payload.subarray(0, 4).toString(), 16);
    const command = packetLines(payload.subarray(0, length))[0];
    const [before, after, rawRef] = command.split(' '), ref = rawRef.split('\0')[0];
    assert.equal(before, '0'.repeat(40)); assert.match(after, /^[a-f0-9]{40}$/); assert.match(ref, /^refs\/heads\/strata\/artifacts\/[a-f0-9]{64}$/);
    assert.ok(command.endsWith('\0report-status\n')); assert.equal(payload.subarray(length, length + 4).toString(), '0000');
    assert.equal(this.refs.has(ref), false, 'Never force/update an existing branch.');
    const pack = payload.subarray(length + 4); assert.equal(pack.subarray(0, 4).toString(), 'PACK'); assert.equal(pack.readUInt32BE(4), 2);
    assert.equal(hash(pack.subarray(0, -20)), pack.subarray(-20).toString('hex'));
    const parsed = new Map<string, { type: string; body: Buffer }>(); let offset = 12;
    for (let i = 0; i < pack.readUInt32BE(8); i++) {
      let byte = pack[offset++], size = byte & 15, shift = 4; const kind = (byte >> 4) & 7;
      while (byte & 128) { byte = pack[offset++]; size += (byte & 127) * 2 ** shift; shift += 7; }
      const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      offset += inflated.engine.bytesWritten; assert.equal(inflated.buffer.length, size);
      const type = ({ 1: 'commit', 2: 'tree', 3: 'blob' } as Record<number, string>)[kind]; assert.ok(type);
      const oid = hash(Buffer.concat([Buffer.from(`${type} ${size}\0`), inflated.buffer])); parsed.set(oid, { type, body: inflated.buffer });
    }
    assert.equal(offset, pack.length - 20); const commit = parsed.get(after)!; assert.equal(commit.type, 'commit');
    const treeHash = commit.body.toString().split('\n')[0].slice(5), tree = parsed.get(treeHash)!; assert.equal(tree.type, 'tree');
    const files = new Map<string, Uint8Array>(); let cursor = 0;
    while (cursor < tree.body.length) {
      const end = tree.body.indexOf(0, cursor), entry = tree.body.subarray(cursor, end).toString(); assert.ok(entry.startsWith('100644 '));
      const oid = Buffer.from(tree.body.subarray(end + 1, end + 21)).toString('hex'), blob = parsed.get(oid)!; assert.equal(blob.type, 'blob');
      files.set(entry.slice(7), new Uint8Array(blob.body)); cursor = end + 21;
    }
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!)); assert.equal(manifest.algorithm, 'sha256');
    const addresses = manifest.objects ?? manifest.hashes.map((h:string) => ({ hash: h, path: h + '.json' }));
    for (const address of addresses) assert.equal(bytesDigest(files.get(address.path)!), address.hash);
    this.refs.set(ref, after); this.files.set(after, files);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('lost reply includes mock-only-token?expires=fixture'); }
    return new Response(packet('unpack ok\n') + packet('ok ' + ref + '\n') + '0000');
  };
  adapter(runBudget = budget()) { return new CloudflareArtifactsAdapter({ mode: 'strict-mock', identity: { account: 'account', namespace: 'default' }, namespace: this,
    repository: 'strata-smoke', budget: runBudget, transport: this.transport, max_repo_tokens: ARTIFACT_REPO_TOKEN_ISSUANCE_LIMIT }); }
}
