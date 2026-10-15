import { deflateSync } from 'node:zlib';
import { crc32 } from './assets.js';
import { bootstrap, proposal } from './fixtures.js';
import { assetDescriptorSchema, bytesDigest, canonical, digest, parse, type Records } from './model.js';
import { LOCAL_PROJECT } from './security.js';

// The same four synthetic objects used by the adapter activation preparation.
export function artifactsTestFixture() {
  const chunk = (name: string, body: Buffer) => {
    const n = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([n, body])));
    return Buffer.concat([size, n, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const binary = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0]))), chunk('IEND', Buffer.alloc(0))]);
  const binaryHash = bytesDigest(binary);
  const descriptor = parse(assetDescriptorSchema, {
    format: 'strata-asset/1', project_id: LOCAL_PROJECT, id: 'adapter_fixture_image', revision: 1, previous: null,
    title: 'Synthetic adapter fixture', access: 'project-private',
    source: { kind: 'local-created', provider: 'deterministic-test-fixture', attribution: 'Synthetic bytes', permitted_uses: ['internal-retention', 'backup'] },
    content_sha256: binaryHash, byte_length: binary.length, media_type: 'image/png', width: 1, height: 1,
    validation: 'bounded-structure/1', imported_by: 'fixture-asset-operator'
  });
  const records: Records = {
    'R0@1': { type: 'snapshot', published: true, data: bootstrap() },
    'adapter_fixture@1': { type: 'layer', published: false, data: proposal('adapter_fixture', 'fixture-author') },
    ['asset@' + digest(descriptor)]: { type: 'asset', published: true, data: descriptor }
  };
  const bytes = new Map([[binaryHash, new Uint8Array(binary)]]);
  const originalBytes = Object.values(records).reduce((n, r) => n + Buffer.byteLength(canonical(r.data)), binary.length);
  const fixtureDigest = bytesDigest(canonical({ records, binary_hash: binaryHash, binary_bytes: binary.length }));
  return { records, bytes, binaryHash, projectId: LOCAL_PROJECT, originalBytes, fixtureDigest };
}
