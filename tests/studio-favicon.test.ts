import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { TestSource, sample } from './explorer-fixture.js';

for (const hosted of [false, true]) {
  test(`Studio favicon is available before sign-in with image MIME and CSP (${hosted ? 'hosted' : 'local'})`, async t => {
    const source = new TestSource(await sample());
    const server = await startExplorer(new ExplorerReader(source), {
      assets: path.resolve('explorer'),
      ...(hosted ? { hosted: { publicOrigin: 'https://studio.example.test', trustedProxyAddresses: ['127.0.0.1'] } } : {}),
    });
    t.after(() => server.close());
    const send = (url: string, method = 'GET', extra: Record<string, string> = {}) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const req = request(server.origin + url, {
        method,
        headers: { ...(hosted ? { host: 'studio.example.test', 'x-forwarded-proto': 'https' } : {}), ...extra },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      });
      req.once('error', reject);
      req.end();
    });

    for (const url of ['/', '/index.html']) {
      const shell = await send(url);
      assert.equal(shell.status, 200);
      assert.match(shell.text, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any">/);
    }
    const icon = await send('/favicon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.equal(icon.headers['x-content-type-options'], 'nosniff');
    assert.equal(icon.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(icon.headers['cache-control'], 'no-store');
    assert.match(String(icon.headers['content-security-policy']), /(?:^|; )img-src 'self';/);
    assert.equal(icon.text, await readFile('explorer/favicon.svg', 'utf8'));
    assert.match(icon.text, /<svg[^>]+viewBox="0 0 64 64"/);

    assert.equal((await send('/favicon.svg?v=1')).status, 400);
    for (const method of ['POST', 'HEAD', 'PUT']) assert.equal((await send('/favicon.svg', method)).status, 400);
    assert.equal((await send('/favicon.svg', 'GET', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await send('/explorer/favicon.svg')).status, 404);
    assert.equal((await send('/favicon.svg/extra')).status, 404);
    assert.equal(source.calls, 0);
  });
}
