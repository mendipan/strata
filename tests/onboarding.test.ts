import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { onboardingAt } from '../scripts/onboarding.js';
import { startLocalBroker } from '../src/local-broker.js';

test('portable packet replays actual CLI, owned decision handoff, measured fixture, release and inheritance without a model', async () => {
  const root = process.cwd(); const broker = await startLocalBroker(path.join(root, '.strata/onboarding-test-state-' + Date.now()), 0);
  try {
    const result = await onboardingAt(root, broker.url, 'node-development-harness');
    assert.equal(result.status, 'passed'); assert.equal(result.scripted_cli_calls, 34);
    assert.equal(result.model_calls, 0); assert.equal(result.cloud_calls, 0);
    assert.equal(result.fresh_model_acceptance, 'pending-separate-authorization');
    assert.equal(result.direct_api_checks.length, 9);
    const refusal = result.trace.find((t: any) => t.id === 'peer-write-refusal');
    assert.equal(refusal.role, 'reminder-author'); assert.equal(refusal.envelope.errors[0].code, 'OWNER_FORBIDDEN');
    assert.equal(result.trace.find((t: any) => t.id === 'decision-draft').stdin.owner, 'author-b');
    assert.ok(result.trace.find((t: any) => t.id === 'decision-endorsement').operator_only);
    assert.equal(result.evidence.results.filter((r: any) => r.method === 'mechanical' && r.passed).length, 6);
    assert.equal(result.evidence.results.filter((r: any) => r.method === 'review').length, 4);
    const saved = await readFile(path.join(result.folder, 'result.json'), 'utf8');
    assert.ok(!saved.includes(broker.url)); assert.ok(!saved.includes('fixture-b')); assert.ok(!saved.includes(root.replaceAll('\\', '\\\\')));
  } finally { await broker.close(); }
});
