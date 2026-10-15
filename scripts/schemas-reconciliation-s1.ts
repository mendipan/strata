import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonical } from '../src/model.js';
import { RECONCILIATION_V2_SCHEMAS } from '../src/reconciliation-records.js';
import { s1Fixture } from '../tests/fixtures/reconciliation-s1/fixtures.js';
import { r1Fixture } from '../tests/fixtures/reconciliation-r1/fixtures.js';

// Isolated S1 generator; never updates frozen legacy schemas or runtime maps.
await mkdir('schemas/reconciliation-s1', { recursive: true });
for (const [type, schema] of Object.entries(RECONCILIATION_V2_SCHEMAS)) {
  await writeFile(`schemas/reconciliation-s1/${type}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
for (const [name, options] of [['sha1', { format: 'sha1' }], ['sha256', { format: 'sha256' }], ['review-only', { reviewCriterion: true }]] as const) {
  const f = s1Fixture(options);
  await writeFile(`tests/fixtures/reconciliation-s1/${name}.json`, canonical({ records: f.records, planned: f.proofPin, committed: f.committedPin,
    completion: f.completionPin, binding: f.bindingPin, publication: f.publication }) + '\n');
}
const old = r1Fixture();
await writeFile('tests/fixtures/reconciliation-s1/legacy-r1.json', canonical({ receipt: old.receipt,
  records: Object.fromEntries(Object.entries(old.records).filter(([, row]) => ['source-binding', 'reconciliation-proposal', 'reconciliation-review'].includes(row.type))) }) + '\n');
