// Small helpers used only by tests/zcode-translation.test.ts. They wrap the
// existing public CLI/broker contracts; they do not copy or replace the broad
// fixture harness in tests/helpers.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { bytesDigest } from '../src/model.js';

export const exec = promisify(execFile);
export type Broker = Awaited<ReturnType<typeof startLocalBroker>>;
export type Cli = (args: string[], record: unknown, session: string) => Promise<any>;

export function makeCli(root: string): Cli {
  return (args, record, session) => runCli([...args, '--project', root, '--json', '--non-interactive', '--offline'],
    record === undefined ? undefined : JSON.stringify(record), { ...process.env, STRATA_SESSION: session });
}

// Semantic store bytes for unchanged-state assertions. The audit log grows by
// design on every request (including denials), so it is excluded here. Every
// stored artifact is hashed individually so preservation checks can prove that
// a successful append never rewrites a prior immutable record's bytes.
export async function stateBytes(root: string) {
  const artifactsDir = path.join(root, 'state', 'artifacts');
  const artifacts = (await readdir(artifactsDir)).sort();
  const artifact_hashes = Object.fromEntries(await Promise.all(artifacts.map(async name =>
    [name, bytesDigest(await readFile(path.join(artifactsDir, name), 'utf8'))])));
  return { registry: await readFile(path.join(root, 'state', 'registry.json'), 'utf8'), artifacts, artifact_hashes };
}

// After a successful append operation, every artifact that existed before must
// still exist with identical bytes; only new artifacts may appear.
export function assertPriorArtifactsPreserved(before: Awaited<ReturnType<typeof stateBytes>>, after: Awaited<ReturnType<typeof stateBytes>>, label: string) {
  for (const [name, hash] of Object.entries(before.artifact_hashes)) {
    assert.ok(after.artifact_hashes[name] !== undefined, `${label}: prior artifact ${name} disappeared`);
    assert.equal(after.artifact_hashes[name], hash, `${label}: prior artifact ${name} changed bytes`);
  }
}

export function obligationMap(obligations: { item: string; value: unknown }[]) {
  return Object.fromEntries(obligations.map(o => [o.item, o.value]));
}

// Runs the generated booking app exactly like a person would: as a process,
// with runtime state outside the pinned output tree.
export async function appCall(output: string, runtime: string, args: string[]) {
  const { stdout } = await exec(process.execPath, [path.join(output, 'booking.mjs'), ...args, '--state-file', runtime]);
  return JSON.parse(stdout);
}

export async function writeJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2));
  return file;
}
