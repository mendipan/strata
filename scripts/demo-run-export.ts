import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { retainedRunReplay } from '../src/demo-run-replay.js';
export async function exportRetainedReplay(directory: string, output: string) {
  const names = ['completion-audit.json', 'run/viewer-events.jsonl', 'run/workflow-export.json', 'run/actor-a.json', 'run/actor-b.json', 'run/actor-c.json', 'run/actor-b-repair.json'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name), 'utf8')])));
  const replay = retainedRunReplay(files); await writeFile(output, JSON.stringify(replay, null, 2), { flag: 'wx' });
  return { chapters: replay.chapters.length, sha256: replay.bundle_sha256 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: node dist/scripts/demo-run-export.js <retained-directory> <new-output.json>');
  console.log(await exportRetainedReplay(process.argv[2], process.argv[3]));
}
