import test from 'node:test';
import assert from 'node:assert/strict';
import { guidedIdentityMatches } from '../scripts/integrated-demo-guided.js';
import { parseDemoLabTarget, demoLabWorkerConfig } from '../src/demo-lab-config.js';
import { DEMO_LAB } from './demo-lab-fixture.js';

test('explicit host target remains exact through config and both CLI identity checks', () => {
  const target = parseDemoLabTarget(DEMO_LAB);
  const config = demoLabWorkerConfig(process.cwd(), '0'.repeat(64), target);
  assert.deepEqual(JSON.parse(config.vars.STRATA_LAB_TARGET), target);
  assert.equal(config.account_id, target.account_id);
  assert.equal(config.artifacts[0].namespace, target.namespace_id);
  const wrangler = { loggedIn: true, authType: 'OAuth Token', accounts: [{ id: target.account_id }],
    tokenPermissions: ['account:read', 'workers_scripts:write', 'artifacts:write'] };
  const cf = { authenticated: true, tokenValid: true, accounts: [{ id: target.account_id }], scopes: ['account:read', 'workers-scripts.read'] };
  assert.equal(guidedIdentityMatches(wrangler, cf, target.account_id), true);
  assert.equal(guidedIdentityMatches(wrangler, cf, 'b'.repeat(32)), false);
  assert.equal(guidedIdentityMatches({ ...wrangler, accounts: [] }, cf, target.account_id), false);
  assert.equal(guidedIdentityMatches(wrangler, { ...cf, accounts: [] }, target.account_id), false);
  assert.equal(guidedIdentityMatches({ ...wrangler, tokenPermissions: [] }, cf, target.account_id), false);
  assert.equal(guidedIdentityMatches(wrangler, { ...cf, scopes: [] }, target.account_id), false);
  assert.equal(guidedIdentityMatches({ ...wrangler, authType: 'API Token' }, cf, target.account_id), false);
  assert.equal(guidedIdentityMatches(wrangler, { ...cf, tokenValid: false }, target.account_id), false);
  for (const invalid of [undefined, {}, { ...target, account_id: undefined }, { ...target, namespace_id: '../elsewhere' }, { ...target, extra: 'ignored?' }])
    assert.throws(() => parseDemoLabTarget(invalid));
});
