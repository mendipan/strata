import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderDiagnostic, providerDiagnostic } from '../src/provider-diagnostic.js';
import { preparedFixture } from './integrated-demo-fixture.js';

test('safe provider diagnostic omits arbitrary messages, credentials, paths and stacks', () => {
  const secret = 'Bearer credential-do-not-export';
  const error = { message: 'Authentication error ' + secret, stderr: 'HTTP 401 [code: 10000] ' + secret,
    code: 1, killed: false, signal: null, stack: secret, token: secret };
  const safe = providerDiagnostic('wrangler.delete-repository', error);
  assert.deepEqual(safe, { stage: 'wrangler.delete-repository', category: 'authentication', status: 401, code: 1, process_killed: false });
  assert.equal(isProviderDiagnostic(safe), true);
  assert.equal(isProviderDiagnostic({ ...safe, raw: secret }), false);
  assert.equal(isProviderDiagnostic({ ...safe, stage: secret }), false);
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('Workflow retains a counted storage failure diagnostic and no decision receipt or new publication', async () => {
  const { fixture } = await preparedFixture(), prior = structuredClone(fixture.checkpoint.registry);
  fixture.strict.get = async () => { throw new Error('Too many subrequests. secret=must-not-export'); };
  const result = await fixture.event('selection', 'operator', fixture.receipt('1200'));
  assert.deepEqual(result.outcome, { ok: false, error: { code: 'ARTIFACT_UNAVAILABLE', diagnostic: { stage: 'read.get', category: 'subrequest-limit' } } });
  assert.equal(result.checkpoint.phase, 'failed'); assert.equal(result.checkpoint.receipts.length, 0);
  assert.deepEqual(result.checkpoint.registry, prior);
  assert.equal(JSON.stringify(result).includes('must-not-export'), false);
});
