import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, open } from 'node:fs/promises';
import { safeJson } from '../src/explorer/contract.js';
import { canonical } from '../src/model.js';
import { noLinks } from '../src/node-state.js';
import { prepareNamespaceBuild } from '../src/explorer/namespace-build-preparation.js';

export async function writeNamespaceBuildPacket(input: string, output: string) {
  if (![input, output].every(p => path.isAbsolute(p) && path.resolve(p) === p) || input === output)
    throw new Error('Use distinct canonical absolute offline input and new packet file paths.');
  const metadata = await import('node:fs/promises').then(fs => fs.lstat(input));
  if (!metadata.isFile() || metadata.size > 16 * 1024 ** 2) throw new Error('Offline preparation input exceeds its bound.');
  await noLinks(input); await noLinks(output);
  const packet = prepareNamespaceBuild(safeJson(await readFile(input, 'utf8'), 16 * 1024 ** 2));
  // Exclusive single-file output; never creates directories or replaces files.
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(canonical(packet)); await handle.sync(); } finally { await handle.close(); }
  return packet.packet_sha256;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') {
    process.stderr.write('Use --input ABSOLUTE_OFFLINE_JSON --output ABSOLUTE_NEW_INACTIVE_PACKET\n'); process.exitCode = 2;
  } else writeNamespaceBuildPacket(args[1], args[3]).then(hash => process.stdout.write(`Inactive packet ${hash}; activation remains separately authorized.\n`)).catch(() => {
    process.stderr.write('Inactive preparation refused. Check exact supplied closure, authority, scope and new output file.\n'); process.exitCode = 1;
  });
}
