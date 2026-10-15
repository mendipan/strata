import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bytesDigest, canonical, digest, fail, MODEL } from '../model.js';
import { noLinks } from '../node-state.js';
import { requireCleanGit, runGit, decodeGit } from '../git-workspace.js';
import { verifyRealization } from '../profile.js';
import { trustedCollectionSource, type CollectionLane } from './collection-fixture.js';
import { COLLECTION_SURFACES, expectedCollection, type CollectionObservations } from './collection-suite.js';

export const COLLECTION_ACCEPTANCE = 'finite-collection-acceptance/1';
export const ACCEPTANCE_LIMITS = { timeout_ms: 5000, process_output_bytes: 64 * 1024, file_bytes: 128 * 1024, worker_memory_mb: 64 } as const;
const declarationSchema = z.array(z.object({ id: z.string().min(1).max(80), disposition: z.enum(['in_scope', 'unknown', 'excluded']), rationale: z.string().min(1).max(500) }).strict()).min(1).max(64);
export type CollectionDeclaration = z.infer<typeof declarationSchema>;
export const DEFAULT_COLLECTION_DECLARATION: CollectionDeclaration = COLLECTION_SURFACES.map(id => ({ id, disposition: 'in_scope', rationale: 'Fixed synthetic collection observable surface.' }));

export function collectionCoverage(declared: CollectionDeclaration) {
  const rows = declarationSchema.parse(declared);
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('INVALID_RECORD', 2, 'Declared surface IDs must be unique.');
  const required = new Set<string>(COLLECTION_SURFACES);
  return [...rows.map(row => ({ ...row, status: row.disposition === 'unknown' ? 'unknown' : required.has(row.id) ? row.disposition === 'in_scope' ? 'covered' : 'uncovered' : row.disposition === 'excluded' ? 'excluded' : 'uncovered' })), ...COLLECTION_SURFACES.filter(id => !rows.some(row => row.id === id)).map(id => ({ id, disposition: 'in_scope', rationale: 'Required fixed-suite surface was not declared.', status: 'uncovered' }))];
}

export function compareCollectionObservations(original: CollectionObservations, baseline: CollectionObservations, changed: CollectionObservations) {
  const before = expectedCollection(3), after = expectedCollection(5);
  return COLLECTION_SURFACES.flatMap(surface => {
    const original_ok = canonical(original?.[surface] ?? null) === canonical(before[surface]);
    const baseline_ok = canonical(baseline?.[surface] ?? null) === canonical(before[surface]);
    const changed_ok = canonical(changed?.[surface] ?? null) === canonical(after[surface]);
    const baseline_equal = canonical(original?.[surface] ?? null) === canonical(baseline?.[surface] ?? null);
    const preserved = surface === 'capacity' ? null : canonical(original?.[surface] ?? null) === canonical(changed?.[surface] ?? null);
    return [
      { id: 'baseline/' + surface, intent: 'preserved', original_matches_literal: original_ok, reconstruction_matches_literal: baseline_ok, equal: baseline_equal, passed: original_ok && baseline_ok && baseline_equal },
      { id: 'changed/' + surface, intent: surface === 'capacity' ? 'intentional-count-3-to-5' : 'preserved', original_matches_literal: original_ok, reconstruction_matches_literal: changed_ok, equal: preserved, passed: original_ok && changed_ok && preserved !== false }
    ];
  });
}

async function ordinaryFile(file: string) {
  await noLinks(file); const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > ACCEPTANCE_LIMITS.file_bytes) fail('UNSUPPORTED_ACCEPTANCE_INPUT', 8, 'Acceptance inputs must be bounded ordinary files without links.');
  const bytes = await readFile(file);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: bytesDigest(bytes), byte_length: bytes.length };
}

async function measureOriginal(root: string, expectedHead: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHead)) fail('INVALID_RECORD', 2, 'Pin the full original Git commit.');
  if (canonical((await readdir(root)).sort()) !== canonical(['.git', 'collection.mjs']) || !(await lstat(path.join(root, '.git'))).isDirectory()) fail('UNSUPPORTED_ACCEPTANCE_INPUT', 8, 'This slice supports only the one-module synthetic original Git fixture.');
  const module = await ordinaryFile(path.join(root, 'collection.mjs'));
  if (module.text !== trustedCollectionSource('original')) fail('UNSUPPORTED_ACCEPTANCE_INPUT', 8, 'Original code is not the fixed independently authored fixture; no supplied app code will execute.');
  const clean = await requireCleanGit({ root, projectId: 'synthetic-acceptance', repoId: 'synthetic-original' });
  if (clean.pins.head_commit !== expectedHead || clean.tree.length !== 1 || clean.tree[0].path !== 'collection.mjs') fail('STALE_SOURCE', 5, 'The exact original commit and one-file tree are required.');
  const branch = decodeGit(await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return { files: { 'collection.mjs': module.text }, pins: { head_commit: clean.pins.head_commit, head_tree: clean.pins.head_tree, index_sha256: clean.pins.index_digest, branch, source_sha256: module.sha256, byte_length: module.byte_length } };
}

async function measureReconstruction(root: string, lane: 'baseline' | 'changed') {
  if (canonical((await readdir(root)).sort()) !== canonical(['README.md', 'collection.mjs', 'realization.json'])) fail('OUTPUT_TAMPERED', 6, 'Reconstruction must contain exactly the flat collection files and manifest.');
  const manifest = await ordinaryFile(path.join(root, 'realization.json'));
  const input = JSON.parse(manifest.text), record = verifyRealization(input.record ?? input);
  const expected = { max_items: lane === 'baseline' ? 3 : 5, max_title_length: 20 };
  if (record.profile_id !== 'collection-node/1' || record.model_version !== MODEL || canonical(record.oracle?.expected) !== canonical(expected) || canonical(Object.keys(record.files).sort()) !== canonical(['README.md', 'collection.mjs']) || record.files['collection.mjs'] !== trustedCollectionSource(lane)) fail('UNSUPPORTED_ACCEPTANCE_INPUT', 8, 'Only exact compiled collection baseline 3/20 and changed 5/20 modules are executable.');
  const files: Record<string, string> = {}, file_pins: Record<string, { sha256: string; byte_length: number }> = {};
  for (const name of ['README.md', 'collection.mjs']) { const file = await ordinaryFile(path.join(root, name)); if (file.text !== record.files[name]) fail('OUTPUT_TAMPERED', 6, 'Reconstruction differs from its pinned manifest.'); files[name] = file.text; file_pins[name] = { sha256: file.sha256, byte_length: file.byte_length }; }
  return { files, pins: { target: record.target, candidate: record.candidate, profile: record.profile, output_tree: record.output_tree, oracle_sha256: record.oracle_sha256, manifest_sha256: manifest.sha256, files: file_pins } };
}

async function executableDigest(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}

async function runWorker(directory: string, lane: CollectionLane, source: string) {
  const worker = fileURLToPath(new URL('./collection-worker.js', import.meta.url));
  const args = ['--no-addons', '--max-old-space-size=' + ACCEPTANCE_LIMITS.worker_memory_mb, worker];
  // No caller NODE_OPTIONS, loader, proxy, credentials or source environment.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]!]));
  const start = performance.now();
  return await new Promise<{ lane: CollectionLane; executable: string; argv: string[]; exit_code: number | null; signal: string | null; failure: string | null; elapsed_ms: number; stdout: string; stderr: string; observations: CollectionObservations | null }>(resolve => {
    const child = spawn(process.execPath, args, { cwd: directory, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, failure: string | null = null;
    const timer = setTimeout(() => { failure = 'TIMEOUT'; child.kill(); }, ACCEPTANCE_LIMITS.timeout_ms);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > ACCEPTANCE_LIMITS.process_output_bytes) { failure = 'OUTPUT_LIMIT'; child.kill(); } else chunks.push(chunk); });
    child.on('error', () => { failure = 'SPAWN_FAILED'; }); child.stdin.on('error', () => {});
    child.on('close', (exit_code, signal) => {
      clearTimeout(timer); const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8'); let observations = null;
      try { const parsed = JSON.parse(out); if (exit_code !== 0 || parsed.format !== 'collection-observations/1' || parsed.runtime !== process.version || canonical(Object.keys(parsed.observations ?? {}).sort()) !== canonical([...COLLECTION_SURFACES].sort())) throw new Error(); observations = parsed.observations; } catch { failure ??= 'WORKER_FAILED'; }
      resolve({ lane, executable: process.execPath, argv: args, exit_code, signal, failure, elapsed_ms: Math.round(performance.now() - start), stdout: out, stderr: err, observations });
    });
    child.stdin.end(JSON.stringify({ lane, source }));
  });
}

export type CollectionAcceptanceInput = { original: string; original_head: string; baseline: string; changed: string; output: string; declared: CollectionDeclaration };
/** Standalone local measurements, never an Engine evidence/approval/completion endpoint. */
export async function runCollectionAcceptance(input: CollectionAcceptanceInput) {
  const roots = await Promise.all([input.original, input.baseline, input.changed].map(async root => realpath(await noLinks(root))));
  const output = await noLinks(input.output), outputParent = await realpath(await noLinks(path.dirname(output)));
  const target = path.join(outputParent, path.basename(output));
  const normalized = [...roots, target].map(root => process.platform === 'win32' ? root.toLowerCase() : root);
  if (normalized.some((root, i) => normalized.some((other, j) => i !== j && (root === other || root.startsWith(other + path.sep))))) fail('INVALID_PATH', 2, 'Original, two reconstructions and new evidence directory must be disjoint.');
  await mkdir(target); // Deliberately no recursive/existing-directory reuse or overwrite.
  const receipt: any = { format: COLLECTION_ACCEPTANCE, status: 'refused', approval: false, release: false, reconciliation_complete: false, equivalence: 'not-established', trust: 'local-synthetic-observations', limits: ACCEPTANCE_LIMITS, coverage: [], checks: [], runs: [], inputs: null, failure: null,
    limitations: ['Only fixed synthetic original and exact collection-node/1 modules at 3/20 and 5/20 execute.', 'Seven declared observable surfaces and finite vectors; omitted behavior, persistence, UI, network and state migration are not established.', 'Candidate/target manifest labels are supplied pins, not independently authenticated retained Engine records or accepted Releases.', 'Separate processes and confined copies execute vetted bytes; this is not a sandbox for arbitrary or hostile application code.', 'No adoption/output bridge, Engine acceptance, approval, Release or reconciliation completion is created.'] };
  try {
    receipt.coverage = collectionCoverage(input.declared);
    const original = await measureOriginal(roots[0], input.original_head), baseline = await measureReconstruction(roots[1], 'baseline'), changed = await measureReconstruction(roots[2], 'changed');
    const suite = await ordinaryFile(fileURLToPath(new URL('./collection-suite.js', import.meta.url))), worker = await ordinaryFile(fileURLToPath(new URL('./collection-worker.js', import.meta.url))), harness = await ordinaryFile(fileURLToPath(import.meta.url));
    receipt.runtime = { node: process.version, platform: process.platform, arch: process.arch, executable_sha256: await executableDigest(process.execPath) };
    receipt.suite = { id: 'collection-original-reconstruction/1', sha256: suite.sha256, worker_sha256: worker.sha256, harness_sha256: harness.sha256, fixture_sha256: bytesDigest(trustedCollectionSource('original')), literal_expectations_sha256: digest({ baseline: expectedCollection(3), changed: expectedCollection(5) }) };
    receipt.inputs = { original: original.pins, baseline: baseline.pins, changed: changed.pins };
    for (const [lane, measured] of [['original', original], ['baseline', baseline], ['changed', changed]] as const) {
      const directory = path.join(target, lane); await mkdir(directory);
      for (const [name, body] of Object.entries(measured.files)) await writeFile(path.join(directory, name), body, { flag: 'wx' });
      const result = await runWorker(directory, lane, measured.files['collection.mjs']);
      await writeFile(path.join(directory, 'stdout.log'), result.stdout, { flag: 'wx' }); await writeFile(path.join(directory, 'stderr.log'), result.stderr, { flag: 'wx' });
      const { stdout, stderr, ...retained } = result;
      receipt.runs.push({ ...retained, stdout_sha256: bytesDigest(stdout), stderr_sha256: bytesDigest(stderr) });
    }
    const after = { original: (await measureOriginal(roots[0], input.original_head)).pins, baseline: (await measureReconstruction(roots[1], 'baseline')).pins, changed: (await measureReconstruction(roots[2], 'changed')).pins };
    if (canonical(after) !== canonical(receipt.inputs)) fail('STALE_SOURCE', 5, 'An input changed while acceptance ran; discard current-freshness claims.');
    receipt.inputs_unchanged = true;
    if (receipt.runs.some((run: any) => run.failure || run.exit_code !== 0 || !run.observations)) receipt.status = 'failed';
    else {
      receipt.checks = compareCollectionObservations(receipt.runs[0].observations, receipt.runs[1].observations, receipt.runs[2].observations);
      receipt.status = receipt.checks.some((check: any) => !check.passed) ? 'failed' : receipt.coverage.some((row: any) => ['unknown', 'uncovered'].includes(row.status)) ? 'incomplete' : 'passed_declared_scope';
    }
  } catch (error) { receipt.failure = { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ACCEPTANCE_REFUSED', message: error instanceof Error ? error.message : String(error) }; }
  await writeFile(path.join(target, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
