import { readFile, stat } from 'node:fs/promises';
import { formatStressEvidence } from '../src/trace.js';
const args = process.argv.slice(2);
if (args[0] !== '--file' || !args[1] || args.length > 3 || (args[2] !== undefined && args[2] !== '--json')) throw new Error('Usage: evidence --file RESULT.json [--json]');
if ((await stat(args[1])).size > 2 * 1024 * 1024) throw new Error('Evidence file exceeds the 2 MiB reader limit.');
const report = JSON.parse(await readFile(args[1], 'utf8'));
if (!report.status || report.actor_kind !== 'deterministic-scripted-sdk-actors') throw new Error('This reader expects a scripted SDK stress result.');
process.stdout.write(args.includes('--json') ? JSON.stringify(report) + '\n' : formatStressEvidence(report));
