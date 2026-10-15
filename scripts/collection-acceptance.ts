import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/core.js';
import { noLinks } from '../src/node-state.js';
import { runGit, decodeGit } from '../src/git-workspace.js';
import { ORIGINAL_COLLECTION } from '../src/acceptance/collection-fixture.js';
import { DEFAULT_COLLECTION_DECLARATION, runCollectionAcceptance } from '../src/acceptance/collection.js';

/** Creates only a new synthetic root. Never initializes or commits an existing app. */
export async function prepareCollectionAcceptanceDemo(requested: string) {
  const root = await noLinks(requested); await mkdir(root);
  const original = path.join(root, 'original'), baseline = path.join(root, 'baseline'), changed = path.join(root, 'changed');
  for (const directory of [original, baseline, changed]) await mkdir(directory);
  await writeFile(path.join(original, 'collection.mjs'), ORIGINAL_COLLECTION, { flag: 'wx' });
  await runGit(original, ['init', '--initial-branch=fixture']);
  await runGit(original, ['add', '--', 'collection.mjs']);
  await runGit(original, ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-m', 'Fixed synthetic original']);
  const original_head = decodeGit(await runGit(original, ['rev-parse', '--verify', 'HEAD'])).trim();
  const fixture = async (name: string) => JSON.parse(await readFile(new URL('../../tests/fixtures/collection/' + name + '.json', import.meta.url), 'utf8'));
  const engine = new Engine(), snapshot = await fixture('bootstrap'); engine.init(snapshot, 'bootstrap');
  const layer = engine.layer(await fixture('extend'), 'author-a'); engine.publish(layer.ref, 'author-a');
  const candidate = engine.compose(await fixture('composition'));
  for (const [directory, target] of [[baseline, snapshot.id + '@' + snapshot.revision], [changed, candidate.ref]]) {
    const record = engine.realize(target, 'collection-node/1');
    for (const [name, body] of Object.entries(record.files)) await writeFile(path.join(directory, name), body, { flag: 'wx' });
    await writeFile(path.join(directory, 'realization.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  return { original, original_head, baseline, changed, output: path.join(root, 'evidence'), declared: structuredClone(DEFAULT_COLLECTION_DECLARATION) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log('Local finite collection acceptance (Node >=22 and Git).\n  demo --output NEW_DIRECTORY\n  check --original DIRECTORY --original-head FULL_SHA --baseline DIRECTORY --changed DIRECTORY --output NEW_DIRECTORY [--declaration JSON_FILE]\nNo package scripts, arbitrary source, hosted identity, approval or equivalence claim.'); return; }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(flags, args[i])) throw new Error('Expected unique named flags and values.'); flags[args[i]] = args[i + 1]; }
  let input;
  if (command === 'demo' && Object.keys(flags).join(',') === '--output') input = await prepareCollectionAcceptanceDemo(flags['--output']);
  else if (command === 'check' && ['--original', '--original-head', '--baseline', '--changed', '--output'].every(key => flags[key]) && Object.keys(flags).every(key => ['--original', '--original-head', '--baseline', '--changed', '--output', '--declaration'].includes(key))) {
    let declared = structuredClone(DEFAULT_COLLECTION_DECLARATION);
    if (flags['--declaration']) { const file = await noLinks(flags['--declaration']), stat = await lstat(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024) throw new Error('Declaration must be a bounded ordinary JSON file.'); declared = JSON.parse(await readFile(file, 'utf8')); }
    input = { original: flags['--original'], original_head: flags['--original-head'], baseline: flags['--baseline'], changed: flags['--changed'], output: flags['--output'], declared };
  } else throw new Error('Unsupported invocation; use --help.');
  const receipt = await runCollectionAcceptance(input);
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, passed: receipt.checks.filter((row: any) => row.passed).length, receipt: path.join(path.resolve(input.output), 'receipt.json'), approval: receipt.approval, equivalence: receipt.equivalence }));
  process.exitCode = receipt.status === 'passed_declared_scope' ? 0 : receipt.status === 'incomplete' ? 5 : receipt.status === 'failed' ? 6 : 8;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
