import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, digest, fail } from './model.js';
import { fixtureOracle } from './booking-checker.js';
import { runFixtureEvidence } from './runner.js';
import { demoBaseline, rehearsalLayer } from './integrated-demo.js';
import type { Realization } from './profile.js';

// Independent finite semantic expectation, constructed from reviewed intent,
// never copied from generated config or an actor's validation assertion.
export function demoOracle(seconds: 900 | 1200) {
  const snapshot = demoBaseline(), hold = rehearsalLayer(seconds === 900 ? 'a' : 'c'), reminder = rehearsalLayer('b', seconds === 1200);
  for (const layer of [hold, reminder]) for (const change of layer.changes) {
    const [collection, key] = change.path.split('.');
    (snapshot.blocks[change.block] as any)[collection][key] = structuredClone(change.value);
  }
  for (const criterion of reminder.acceptance) snapshot.blocks[criterion.block].acceptance[criterion.id] = criterion.criterion;
  return fixtureOracle(snapshot);
}
export async function measureDemoApp(realization: Realization, seconds: 900 | 1200) {
  const directory = await mkdtemp(path.join(tmpdir(), 'strata-integrated-booking-'));
  try {
    for (const [name, body] of Object.entries(realization.files)) await writeFile(path.join(directory, name), body);
    await writeFile(path.join(directory, 'realization.json'), canonical(realization));
    const measured = await runFixtureEvidence(directory, realization, demoOracle(seconds));
    if (measured.evidence.results.some(result => !result.passed)) fail('DEMO_MEASUREMENT_FAILED', 6, 'Generated booking app failed independently expected behavior.');
    return { ...measured, observations_digest: digest(measured.observations), source: 'Node measured generated ordinary files; scripted purpose review' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
