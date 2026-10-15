import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
for (const entry of ['core', 'source-binding', 'adoption/contract', 'adoption/records', 'adoption/persistent', 'service', 'backup']) {
  test('A2 independent module entry: ' + entry, async () => {
    const url = new URL('../src/' + entry + '.js', import.meta.url).href;
    const result = await run(process.execPath, ['--input-type=module', '--eval', 'await import(' + JSON.stringify(url) + ');'], { timeout: 10000, windowsHide: true });
    assert.equal(result.stderr, '');
  });
}
