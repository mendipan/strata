import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('fixed Studio code inventory covers every served browser asset and compiled agent module', async () => {
  const inventory = JSON.parse(await readFile('deploy/studio/release-files.json', 'utf8'));
  assert.equal(inventory.format, 'strata-studio-code-inventory/1');
  const files = new Set<string>(inventory.files);
  assert.equal(files.size, inventory.files.length);
  const host = await readFile('src/explorer/host.ts', 'utf8');
  const assets = new Set([...host.matchAll(/'([\w-]+\.(?:html|js|css|svg))'/g)].map(match => match[1]));
  const modules = host.match(/for \(const module of \[([^\]]+)\]/)![1];
  for (const match of modules.matchAll(/'([^']+)'/g)) assets.add(match[1] + '.js');
  for (const asset of assets) {
    assert.ok(files.has('explorer/' + asset), 'missing served asset: ' + asset);
    const source = await readFile(path.join('explorer', asset), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"]\.\/([^'"]+)['"]/g)) {
      assert.ok(files.has('explorer/' + match[1]), 'missing browser import: ' + match[1]);
    }
  }
  for (const name of await readdir('src/studio-agents')) {
    if (name.endsWith('.ts') && !['worker.ts', 'worker-env.d.ts'].includes(name)) {
      assert.ok(files.has('dist/src/studio-agents/' + name.slice(0, -3) + '.js'), name);
    }
  }
  for (const artifact of ['dist/scripts/studio-host.js', 'dist/scripts/studio-owner-control.js',
    'dist/studio-agent-worker/worker.mjs', 'dist/studio-agent-runner.zip']) assert.ok(files.has(artifact), artifact);
  for (const name of files) assert.doesNotMatch(name, /(^|\/)(\.strata|private|node_modules|host\.json|credentials|grants|receipts)(\/|$)/);
});

test('agent ingress includes service setup and runner/chat routes while retaining inherited proxy restrictions', async () => {
  const config = await readFile('deploy/studio/nginx.conf.example', 'utf8');
  const match = config.match(/location\s+~\s+(\S+)\s*\{([^}]+)\}/)!;
  const routes = new RegExp(match[1]);
  for (const name of ['/studio/v1/owner/agents', '/studio/v1/owner/agents/operations/original',
    '/studio/v1/owner/agent-connections', '/studio/v1/owner/agent-conversations/original',
    '/studio/v1/agent-runners/pair']) assert.ok(routes.test(name), name);
  for (const name of ['/studio/v1/operation', '/studio/v1/preview', '/studio/login',
    '/studio/v1/owner/credentials', '/explorer/v1/refresh']) assert.equal(routes.test(name), false, name);
  assert.match(match[2], /client_max_body_size\s+128k;/);
  assert.match(match[2], /proxy_read_timeout\s+120s;/);
  assert.doesNotMatch(match[2], /proxy_set_header/); // nginx inherits the complete server header set.
  const shared = config.slice(0, config.indexOf('    location'));
  for (const name of ['X-Forwarded-Host', 'X-Forwarded-For', 'X-Real-IP', 'Forwarded', 'Connection']) {
    assert.ok(shared.includes('proxy_set_header ' + name + ' "";'), name);
  }
  assert.match(shared, /client_max_body_size\s+1k;/);
  for (const route of ['preview', 'operation']) {
    assert.match(config, new RegExp('location\\s+=\\s+/studio/v1/' + route + '\\s*\\{[^}]+client_max_body_size\\s+1m;'));
  }
});
