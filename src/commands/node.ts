import { readFile, writeFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonical, fail } from '../model.js';
import { treeDigest, type Realization } from '../profile.js';

export type OperationCall = (command: string, input: any) => Promise<any>;
export async function safePath(root: string, requested: string, requireExisting = false): Promise<string> {
  const base = await realpath(root), target = path.resolve(root, requested), relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('INVALID_PATH', 2, 'Path must be inside the project and cannot be the project root.');
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('INVALID_PATH', 2, 'Paths through symbolic links or junctions are refused.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (requireExisting) await lstat(target);
  return target;
}
export async function verifyOutput(root: string, manifestFile: string) {
  const file = await safePath(root, path.relative(root, path.resolve(manifestFile)), true);
  let manifest: any;
  try { manifest = JSON.parse(await readFile(file, 'utf8')); } catch { fail('INVALID_RECORD', 2, 'A readable realization manifest is required.'); }
  if (!manifest.realization_ref || !manifest.record?.files || typeof manifest.record.files !== 'object') fail('INVALID_RECORD', 2, 'A registered realization manifest is required.');
  const dir = path.dirname(file), actual: Record<string, string> = {};
  for (const name of Object.keys(manifest.record.files)) {
    const full = await safePath(root, path.relative(root, path.join(dir, name)), true);
    actual[name] = await readFile(full, 'utf8');
  }
  const listing = (await readdir(dir)).sort(), expected = [...Object.keys(actual), 'realization.json'].sort();
  if (canonical(listing) !== canonical(expected) || treeDigest(actual) !== manifest.record.output_tree || canonical(actual) !== canonical(manifest.record.files)) fail('OUTPUT_TAMPERED', 6, 'Realization files changed, are missing, or contain unmanifested files.');
  return manifest;
}
// Both interactive surfaces use this orchestration. Engine operations alone do
// not replace filesystem verification, and no client can supply shell commands.
export async function runNodeCommand(root: string, call: OperationCall, command: string, input: any, dry = false) {
  if (command === 'materialize') {
    const output = await safePath(root, input.out);
    try { if ((await readdir(output)).length) fail('OUTPUT_EXISTS', 5, 'Materialization refuses a nonempty directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const record: Realization = await call('materialize', { target: input.target, profile: input.profile });
    if (dry) return { target: record.target, candidate: record.candidate, profile: record.profile, output_tree: record.output_tree, coverage: record.coverage, execution_ready: true, intended_output: output };
    const registration = await call('realization.register', { record });
    try {await mkdir(output, { recursive: true });
    for (const [name, body] of Object.entries(record.files)) {
      const full = await safePath(root, path.relative(root, path.join(output, name)));
      await writeFile(full, body, { flag: 'wx' });
    }
    const manifest = path.join(output, 'realization.json');
    await writeFile(manifest, JSON.stringify({ realization_ref: registration.ref, record }, null, 2) + '\n', { flag: 'wx' });
    return { ref: registration.ref, manifest, output, candidate: record.candidate, profile: record.profile, output_tree: record.output_tree, coverage: record.coverage };
    }catch{fail('OUTPUT_INCOMPLETE',9,'The realization was registered but its export did not complete. Reconcile the retained ref; inspect the partial directory before choosing another output slot.',{realization_ref:registration.ref,output});}
  }
  if (command === 'validate') {
    const manifest = await verifyOutput(root, input.manifest);
    const retained = await call('inspect', { type: 'realization', ref: manifest.realization_ref });
    if (canonical(retained) !== canonical(manifest.record)) fail('OUTPUT_TAMPERED', 6, 'Manifest content does not match stored realization.');
    return call('validate', { target: input.target, realization: manifest.realization_ref, evidence: input.evidence });
  }
  if (command === 'release') {
    const validation = await call('inspect', { type: 'validation', ref: input.validation });
    const realization = await call('inspect', { type: 'realization', ref: validation.realization });
    const manifests: string[] = [];
    let visited=0;async function scan(dir: string,depth=0) {if(depth>16)fail('READ_LIMIT',2,'Realization search exceeds its directory-depth bound.');
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {if(++visited>5000)fail('READ_LIMIT',2,'Realization search exceeds its entry bound.');
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'state') await scan(full,depth+1);
        else if (entry.isFile() && entry.name === 'realization.json') manifests.push(full);
        if (manifests.length > 1000) fail('READ_LIMIT', 2, 'Too many local realization manifests.');
      }
    }
    await scan(await safePath(root, '.strata'));
    let found = false;
    for (const file of manifests) {
      const candidate = JSON.parse(await readFile(file, 'utf8'));
      if (candidate.realization_ref !== validation.realization) continue;
      const verified = await verifyOutput(root, file);
      if (canonical(verified.record) !== canonical(realization)) fail('OUTPUT_TAMPERED', 6, 'Manifest content does not match stored realization.');
      found = true; break;
    }
    if (!found) fail('REALIZATION_FILES_REQUIRED', 6, 'Place local realizations under .strata so release can recheck the output bytes.');
    return call('release', { target: input.target, validation: input.validation, approvals: input.approvals });
  }
  return call(command, input);
}
