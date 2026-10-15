import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExplorerArgs, reviewGrant } from '../src/explorer/launch.js';
import { config } from './explorer-fixture.js';

const exact = ['--config', 'C:/synthetic/connection.json', '--expect-repository-id', 'synthetic-repo', '--review-draft', 'L-review@1', '--review-sha256', 'a'.repeat(64)];
test('local launch keeps repository and exact draft pins outside browser input and binds expiry to source grant', () => {
  const c = config(), options = parseExplorerArgs([...exact, '--allow-remote-read', '--port', '0']);
  assert.equal(options.expectedRepositoryId, 'synthetic-repo');
  assert.equal(options.port, 0);
  assert.deepEqual(reviewGrant(c, options), { project_id:c.project_id, ref:'L-review@1', sha256:'a'.repeat(64), expires_at:c.read_authorization.expires_at });
  assert.equal(reviewGrant(c, parseExplorerArgs(['--sample'])), undefined);
  c.read_authorization.expires_at = '2000-01-01T00:00:00Z';
  assert.throws(() => reviewGrant(c, options), (e:any) => e.code === 'SOURCE_AUTH');
});
test('ambiguous or incomplete launch options fail before any credential or provider dispatch', () => {
  for (const args of [
    ['--sample', '--allow-remote-read'], ['--review-draft', 'L-review@1'],
    exact.slice(0, -2), exact.filter((_,i) => i !== 2 && i !== 3),
    [...exact, '--review-sha256', 'b'.repeat(64)],
    [...exact.slice(0,-1), 'not-a-hash'], ['--config', '--port', '0'],
    ['--port', '1e3'], ['--port', '65536'], ['--session', 'foreign'],
  ]) assert.throws(() => parseExplorerArgs(args), args.join(' '));
});
