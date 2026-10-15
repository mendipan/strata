import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { runCli, formatHuman, HELP } from '../src/cli.js';
import { startLocalBroker } from '../src/local-broker.js';
import { BLOCK_MODEL, bytesDigest } from '../src/model.js';

const base = JSON.parse(await readFile('strata.config.json', 'utf8'));
async function project(config: any = base) {
  const root = await mkdtemp(path.join(tmpdir(), 'strata-doctor-'));
  await writeFile(path.join(root, 'strata.config.json'), JSON.stringify(config));
  return root;
}
async function run(root: string, flags: string[] = []) { return runCli(['doctor', '--project', root, '--json', ...flags], undefined, {}); }
async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of Object.entries(await files(full))) result[entry.name + '/' + name] = bytes;
    else result[entry.name] = bytesDigest(await readFile(full));
  }
  return result;
}

test('offline doctor reports supported configuration, unavailable verification and checks not performed without effects', async () => {
  const root = await project(); const before = await files(root);
  const result = await run(root, ['--offline']);
  assert.equal(result.ok, true);
  assert.equal(result.data.configuration_healthy, true);
  assert.deepEqual(result.data.capabilities.cli_support, HELP.capabilities);
  assert.equal(result.data.checks.find((c: any) => c.id === 'broker_health').status, 'not_checked');
  assert.equal(result.data.verification.find((c: any) => c.id === 'independent_attestation').status, 'unavailable');
  assert.equal(result.data.verification.find((c: any) => c.id === 'execution').status, 'not_checked');
  assert.deepEqual(result.effects, { created: [], reused: [], paths: [], network: [], usage: [] });
  assert.deepEqual(await files(root), before);
  const human = formatHuman(result);
  assert.match(human, /configuration: passed/);
  assert.match(human, /broker_health: not_checked/);
  assert.match(human, /independent_attestation: unavailable/);
  assert.match(human, /does not prove a test ran/);
});

test('health GET leaves real broker registry, audit, lease and configuration bytes untouched', async () => {
  const root = await project();
  const broker = await startLocalBroker(path.join(root, 'state'), 0);
  try {
    await writeFile(path.join(root, 'strata.config.json'), JSON.stringify({ ...base, broker: broker.url }));
    const before = await files(root); const result = await run(root);
    assert.equal(result.ok, true);
    assert.equal(result.data.checks.find((c: any) => c.id === 'broker_health').status, 'passed');
    assert.equal(result.data.capabilities.runtime, 'node-development-harness');
    assert.equal(result.data.capabilities.runtime_capabilities, 'not_checked');
    assert.deepEqual(result.effects.network, ['loopback-health']);
    assert.deepEqual(result.effects.usage, []);
    assert.deepEqual(await files(root), before);
  } finally { await broker.close(); }
});

test('configuration failures retain the existing refusal codes and skip all probes', async () => {
  for (const [config, code, exit] of [
    [{ ...base, broker: 'https://example.com' }, 'NETWORK_FORBIDDEN', 7],
    [{ ...base, artifact_adapter: 'cloudflare-artifacts' }, 'COST_APPROVAL_REQUIRED', 7],
    [{ ...base, model_version: 'unsupported' }, 'UNSUPPORTED_MODEL_VERSION', 8],
    [{ ...base, broker: 'bad-url' }, 'INVALID_ARGUMENT', 2]
  ] as const) {
    const root = await project(config); const before = await files(root); const result = await run(root);
    assert.equal(result.ok, false); assert.equal(result.exit_code, exit);
    assert.equal(result.errors[0].code, code);
    assert.equal(result.data.checks[0].status, 'failed');
    assert.equal(result.data.checks.at(-1).status, 'not_checked');
    assert.deepEqual(result.effects.network, []);
    assert.deepEqual(await files(root), before);
  }
  const root = await project(); await writeFile(path.join(root, 'strata.config.json'), '{');
  assert.equal((await run(root)).data.checks[0].status, 'failed');
  const missing = await mkdtemp(path.join(tmpdir(), 'strata-doctor-missing-'));
  assert.equal((await run(missing)).errors[0].code, 'PROJECT_NOT_FOUND');
});

test('absent health is unavailable; wrong health is failed; redirects never reach another route', async () => {
  let mode = 'wrong', extraCalls = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/health') { extraCalls++; response.end('{}'); return; }
    assert.equal(request.method, 'GET');
    if (mode === 'redirect') { response.writeHead(302, { location: '/unexpected' }); response.end(); }
    else if (mode === 'oversized') response.end('x'.repeat(5000));
    else response.end(JSON.stringify({ local: false }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const root = await project({ ...base, broker: `http://127.0.0.1:${port}` });
  try {
    assert.equal((await run(root)).data.checks.at(-1).status, 'failed');
    mode = 'redirect'; assert.equal((await run(root)).data.checks.at(-1).status, 'unavailable');
    mode = 'oversized'; assert.equal((await run(root)).data.checks.at(-1).status, 'unavailable');
    assert.equal(extraCalls, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const result = await run(root);
  assert.equal(result.ok, true);
  assert.equal(result.data.checks.at(-1).status, 'unavailable');
  assert.equal(result.data.configuration_healthy, true);
});

test('unsupported declared profiles and identity are failed independently of an offline probe', async () => {
  const root = await project({ ...base, profiles: ['unknown'], identity_policy: 'hosted' });
  const result = await run(root, ['--offline']);
  assert.equal(result.ok, false);
  assert.equal(result.data.configuration_healthy, false);
  assert.deepEqual(result.data.checks.filter((c: any) => c.status === 'failed').map((c: any) => c.id), ['profiles', 'identity_policy']);
  assert.deepEqual(result.effects.network, []);
  const incompatible = await run(await project({ ...base, profiles: ['booking-node/2'] }), ['--offline']);
  assert.equal(incompatible.data.checks.find((c: any) => c.id === 'profiles').status, 'failed');
});

test('omitted identity label is admitted for the existing v0.3 local transport without claiming named authority',async()=>{
  const config={...base,model_version:BLOCK_MODEL,profiles:['collection-host/1']};delete config.identity_policy;
  const root=await project(config),before=await files(root),original=globalThis.fetch;
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Offline diagnosis must not contact an issuer.');};
  try{
    const result=await run(root,['--offline']);
    assert.equal(result.ok,true);assert.equal(result.exit_code,0);assert.equal(result.data.configuration_healthy,true);
    assert.equal(result.data.checks.find((c:any)=>c.id==='identity_policy').status,'not_checked');
    assert.equal(result.data.checks.find((c:any)=>c.id==='profiles').status,'passed');
    assert.equal(result.data.verification.find((c:any)=>c.id==='hosted_identity').status,'not_checked');
    assert.match(result.data.checks.find((c:any)=>c.id==='identity_policy').message,/configured issuer/);
    assert.equal(result.data.capabilities.runtime_capabilities,'not_checked');assert.equal(calls,0);
    assert.deepEqual(result.effects,{created:[],reused:[],paths:[],network:[],usage:[]});assert.deepEqual(await files(root),before);
  }finally{globalThis.fetch=original;}
});

test('omitted label does not admit incompatible profiles, malformed identity declarations or remote transports',async()=>{
  const config={...base,model_version:BLOCK_MODEL,profiles:['collection-host/1']};delete config.identity_policy;
  for(const [patch,code,exit] of [
    [{profiles:['booking-node/1']},'DIAGNOSTIC_FAILED',2],
    [{identity_policy:'host-accounts/1'},'DIAGNOSTIC_FAILED',2],
    [{identity_policy:null},'DIAGNOSTIC_FAILED',2],
    [{identity_policy:{issuer:'HostIssuer'}},'DIAGNOSTIC_FAILED',2],
    [{broker:'https://studio.example'},'NETWORK_FORBIDDEN',7],
    [{artifact_adapter:'hosted-local-state'},'COST_APPROVAL_REQUIRED',7],
    [{model_version:'strata/unsupported'},'UNSUPPORTED_MODEL_VERSION',8]
  ] as const){
    const root=await project({...config,...patch}),before=await files(root),result=await run(root,['--offline']);
    assert.equal(result.ok,false);assert.equal(result.exit_code,exit);assert.equal(result.errors[0].code,code);
    assert.equal(result.data.configuration_healthy,false);assert.deepEqual(result.effects.network,[]);assert.deepEqual(await files(root),before);
  }
});

test('a stalled loopback health response is bounded and reported unavailable', async () => {
  const server = createServer((_request, response) => { response.writeHead(200); response.write('{'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await project({ ...base, broker: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  try {
    const started = Date.now(), result = await run(root);
    assert.equal(result.data.checks.at(-1).status, 'unavailable');
    assert(Date.now() - started < 5000, 'the partial response must not hang diagnostics');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
