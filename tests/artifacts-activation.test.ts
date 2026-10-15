import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { activationPlan, runActivation, runLocalProxy, runMock } from '../scripts/artifacts-activation.js';
import { StrictArtifacts } from './artifacts-fixture.js';
import { StrataError } from '../src/model.js';

test('plan and blocked live/invalid modes cannot call the provider factory', async () => {
  let calls = 0; const factory = async () => { calls++; throw new Error('must not dispatch'); };
  assert.deepEqual(await runActivation(['--plan'], factory), activationPlan());
  assert.equal(activationPlan().billing.provider_invoice_cap_proven, false);
  for (const args of [['--live'], ['--live', '--approved'], [], ['--remote']]) {
    await assert.rejects(runActivation(args, factory), e => e instanceof StrataError);
  }
  assert.equal(calls, 0);
});

test('local probe passes public API options with fixed vars-only config, and disposes/cleans up', async () => {
  let configPath = '', disposed = 0; const oldNodeEnv = process.env.NODE_ENV;
  const result = await runLocalProxy(async options => {
    configPath = options.configPath!;
    assert.equal(options.remoteBindings, false); assert.equal(options.persist, false); assert.deepEqual(options.envFiles, []);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      name: 'strata-local-interface-probe', compatibility_date: '2026-10-03', send_metrics: false, vars: { STRATA_PROBE: 'local-only' }
    });
    assert.equal(process.env.CLOUDFLARE_CF_FETCH_ENABLED, 'false');
    assert.equal(process.env.WRANGLER_SEND_METRICS, 'false');
    return { env: { STRATA_PROBE: 'local-only' }, dispose: async () => { disposed++; } };
  });
  assert.equal(result.provider_binding_tested, false); assert.equal(disposed, 1);
  assert.equal(process.env.NODE_ENV, oldNodeEnv); await assert.rejects(access(path.dirname(configPath)));
});

test('local binding mismatch and factory rejection clean up without a remote fallback', async () => {
  let disposed = 0, configPath = '';
  await assert.rejects(runLocalProxy(async options => {
    configPath = options.configPath!;
    return { env: { STRATA_PROBE: 'wrong' }, dispose: async () => { disposed++; } };
  }));
  assert.equal(disposed, 1); await assert.rejects(access(path.dirname(configPath)));
  await assert.rejects(runLocalProxy(async options => { configPath = options.configPath!; throw new Error('local initialization failed'); }));
  await assert.rejects(access(path.dirname(configPath)));
});

test('prepared four-object mock verifies persisted cold bytes and reuses identical retry', async () => {
  const fixture = new StrictArtifacts(), result = await runMock(fixture);
  assert.equal(result.objects, 4); assert.equal(result.pushes, 1); assert.equal(result.tokens_revoked, 2);
  // Two staged batches + one batched record read + one binary read.
  assert.equal(result.capabilities_disposed, 4); assert.equal(result.exact_cold_read, true);
  assert.equal(fixture.calls.filter(c => c === 'get').length, 4);
  assert.equal(fixture.openHandles, 0);
  assert.equal(fixture.calls.filter(c => c === 'readFile').length, 12);
  fixture.corruptRead = true; await assert.rejects(runMock(fixture), e => e instanceof StrataError && e.code === 'ARTIFACT_DIGEST');
  assert.equal(fixture.openHandles, 0, 'Digest refusal still disposes every acquired capability.');
});
