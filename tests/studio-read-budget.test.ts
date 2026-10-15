import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FileReadBudget, initialReadBudget } from '../src/explorer/read-budget.js';
import { RestArtifactsReader } from '../src/explorer/source.js';
import { loadHostedConfig } from '../scripts/studio-host.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { config } from './explorer-fixture.js';

const code = (expected: string) => (error: any) => error.code === expected;
const pin = 'synthetic-repository-id';
async function fixture(requests = 2, bytes = 131072) {
  const directory = await mkdtemp(path.join(tmpdir(), 'strata-read-budget-'));
  await chmod(directory, 0o700);
  const file = path.join(directory, 'read-budget.json'), connection = config();
  connection.registry_path = path.resolve(directory, '..', 'synthetic-registry.json');
  connection.read_authorization.max_requests = requests;
  connection.read_authorization.max_bytes = bytes;
  await writePrivate(file, initialReadBudget(connection, pin), true);
  const budget = () => new FileReadBudget(file, connection, pin);
  const state = async () => JSON.parse(await readFile(file, 'utf8'));
  return {directory, file, connection, budget, state};
}

test('durable totals survive recreation and keep exact request and byte limits', async () => {
  const f = await fixture(2, 9);
  await f.budget().reserve(4);
  await f.budget().ready();
  await f.budget().reserve(5);
  assert.equal((await f.state()).reserved_requests, 2);
  assert.equal((await f.state()).reserved_bytes, 9);
  await assert.rejects(f.budget().reserve(1), code('READ_SESSION_LIMIT'));
  assert.equal((await f.state()).reserved_bytes, 9);
});

test('missing ledger never initializes itself at readiness or reservation', async () => {
  const f = await fixture(); await unlink(f.file);
  await assert.rejects(f.budget().ready(), code('READ_BUDGET_UNAVAILABLE'));
  await assert.rejects(f.budget().reserve(1), code('READ_BUDGET_UNAVAILABLE'));
  await assert.rejects(lstat(f.file), {code: 'ENOENT'});
});

test('entire connection, grant and immutable repository ID are pinned, never reset on change', async () => {
  const mutations = [
    (c: any) => c.connection_id = 'another', (c: any) => c.project_id = 'another',
    (c: any) => c.display_name = 'another', (c: any) => c.registry_path += '.another',
    (c: any) => c.storage.account = '1'.repeat(32), (c: any) => c.storage.namespace = 'another',
    (c: any) => c.storage.repository = 'another', (c: any) => c.read_authorization.principal = 'another',
    (c: any) => c.read_authorization.policy_generation = 'another',
    (c: any) => c.read_authorization.max_requests++, (c: any) => c.read_authorization.max_bytes++,
    (c: any) => c.read_authorization.expires_at = new Date(Date.now() + 120000).toISOString(),
  ];
  const f = await fixture(); await f.budget().reserve(1); const before = await readFile(f.file, 'utf8');
  for (const change of mutations) {
    const c = structuredClone(f.connection); change(c);
    await assert.rejects(new FileReadBudget(f.file, c, pin).ready(), code('READ_BUDGET_UNAVAILABLE'));
  }
  await assert.rejects(new FileReadBudget(f.file, f.connection, pin + '-different').ready(), code('READ_BUDGET_UNAVAILABLE'));
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('malformed, extra fields, negative, unsafe or over-grant totals fail closed without writes', async () => {
  const f = await fixture(); const initial = initialReadBudget(f.connection, pin);
  for (const contents of ['not-json', JSON.stringify({...initial, extra: true}), JSON.stringify({...initial, reserved_requests: -1}),
    JSON.stringify({...initial, reserved_requests: 3}), JSON.stringify({...initial, reserved_bytes: Number.MAX_SAFE_INTEGER})]) {
    await writeFile(f.file, contents); await chmod(f.file, 0o600);
    await assert.rejects(f.budget().reserve(1), code('READ_BUDGET_UNAVAILABLE'));
    assert.equal(await readFile(f.file, 'utf8'), contents);
  }
});

test('exclusive stale lease remains blocked across recreation and requires operator reconciliation', async () => {
  const f = await fixture(), lease = path.join(f.directory, '.owner.lock');
  await writeFile(lease, 'public synthetic interrupted reservation', {mode: 0o600});
  await assert.rejects(f.budget().ready(), code('READ_BUDGET_UNAVAILABLE'));
  await assert.rejects(f.budget().reserve(1), code('READ_BUDGET_UNAVAILABLE'));
  assert.equal((await f.state()).reserved_requests, 0);
  assert.equal(await readFile(lease, 'utf8'), 'public synthetic interrupted reservation');
});

test('reservation is visible durably before credential access and transport, failures never refund', async () => {
  const f = await fixture(2, 131072); let credentials = 0, dispatches = 0;
  const makePort = () => new RestArtifactsReader(f.connection, async () => {
    assert.equal((await f.state()).reserved_requests, ++credentials); return 'synthetic-only';
  }, async () => { dispatches++; throw new Error('synthetic transport failure'); }, pin, f.budget());
  await assert.rejects(makePort().getManyAt([]), code('SOURCE_UNAVAILABLE'));
  await assert.rejects(makePort().getManyAt([]), code('SOURCE_UNAVAILABLE'));
  await assert.rejects(makePort().getManyAt([]), code('READ_SESSION_LIMIT'));
  assert.equal(credentials, 2); assert.equal(dispatches, 2);
  assert.equal((await f.state()).reserved_bytes, 131072);
});

test('unavailable accounting and pre-aborted request never access credentials or provider', async () => {
  const f = await fixture(); let calls = 0; await unlink(f.file);
  const port = new RestArtifactsReader(f.connection, async () => {calls++; return 'synthetic-only';}, async () => {calls++; throw Error();}, pin, f.budget());
  await assert.rejects(port.getManyAt([]), code('READ_BUDGET_UNAVAILABLE'));
  await assert.rejects(port.getManyAt([], AbortSignal.abort()), code('SOURCE_UNAVAILABLE'));
  assert.equal(calls, 0);
});

test('source expiry is rechecked after asynchronous accounting before credential access', async () => {
  const f = await fixture(); let calls = 0;
  const port = new RestArtifactsReader(f.connection, async () => {calls++; return 'synthetic-only';}, fetch, pin,
    {async reserve() { f.connection.read_authorization.expires_at = '2000-01-01T00:00:00Z'; }});
  await assert.rejects(port.getManyAt([]), code('SOURCE_AUTH')); assert.equal(calls, 0);
});

test('cancellation during durable accounting keeps the reservation and prevents credential access', async () => {
  const f = await fixture(); let calls = 0; const abort = new AbortController();
  const port = new RestArtifactsReader(f.connection, async () => {calls++; return 'synthetic-only';}, fetch, pin,
    {async reserve(maximum) { await f.budget().reserve(maximum); abort.abort(); }});
  await assert.rejects(port.getManyAt([], abort.signal), code('SOURCE_UNAVAILABLE'));
  assert.equal(calls, 0); assert.equal((await f.state()).reserved_requests, 1);
});

test('abrupt child exit inside an exclusive reservation leaves a fail-closed lease', async () => {
  const f = await fixture(), module = new URL('../src/explorer/owner-files.js', import.meta.url).href;
  const program = `import {withLease} from ${JSON.stringify(module)}; await withLease(process.argv[1],async()=>process.exit(77));`;
  const outcome = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',program,f.directory], {stdio:'ignore'});
    child.once('error', reject); child.once('exit', code => resolve(code!));
  });
  assert.equal(outcome, 77);
  await assert.rejects(f.budget().ready(), code('READ_BUDGET_UNAVAILABLE'));
  assert.equal((await f.state()).reserved_requests, 0);
  assert.ok((await lstat(path.join(f.directory,'.owner.lock'))).isFile());
});

test('separate processes compete for one durable reservation without replay after exit', async () => {
  const f = await fixture(1, 1), module = new URL('../src/explorer/read-budget.js', import.meta.url).href;
  const program = `import {FileReadBudget} from ${JSON.stringify(module)}; const [file,connection,pin]=JSON.parse(process.argv[1]); try {await new FileReadBudget(file,connection,pin).reserve(1); process.exitCode=0;} catch(e) {process.exitCode=['READ_BUDGET_UNAVAILABLE','READ_SESSION_LIMIT'].includes(e.code)?3:9;}`;
  const child = () => new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify([f.file, f.connection, pin])], {stdio:'ignore'});
    c.once('error', reject); c.once('exit', code => resolve(code!));
  });
  const outcomes = await Promise.all([child(), child()]);
  assert.deepEqual(outcomes.sort(), [0, 3]);
  assert.equal((await f.state()).reserved_requests, 1);
  assert.equal(await child(), 3);
});

test('expired grants and invalid declared maxima cannot reserve', async () => {
  const f = await fixture();
  for (const maximum of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.budget().reserve(maximum), code('READ_BUDGET_UNAVAILABLE'));
  f.connection.read_authorization.expires_at = '2000-01-01T00:00:00Z';
  await assert.rejects(f.budget().reserve(1), code('SOURCE_AUTH'));
  assert.equal((await f.state()).reserved_requests, 0);
});

test('unsafe file modes and directory modes fail closed on POSIX', {skip: process.platform === 'win32'}, async () => {
  const f = await fixture(); await chmod(f.file, 0o644);
  await assert.rejects(f.budget().reserve(1), code('READ_BUDGET_UNAVAILABLE'));
  await chmod(f.file, 0o600); await chmod(f.directory, 0o755);
  await assert.rejects(f.budget().ready(), code('READ_BUDGET_UNAVAILABLE'));
});

test('link traversal and noncanonical paths cannot select another ledger', async () => {
  const f = await fixture(); const link = f.directory + '-link'; await symlink(f.directory, link, 'junction');
  await assert.rejects(new FileReadBudget(path.join(link, 'read-budget.json'), f.connection, pin).ready(), code('READ_BUDGET_UNAVAILABLE'));
  assert.throws(() => new FileReadBudget('relative.json', f.connection, pin), code('READ_BUDGET_UNAVAILABLE'));
  assert.throws(() => new FileReadBudget(f.directory + path.sep + '..' + path.sep + path.basename(f.directory) + path.sep + 'read-budget.json', f.connection, pin), code('READ_BUDGET_UNAVAILABLE'));
});

test('hosted source requires explicit durable accounting, separate from owner/connection/key paths', async () => {
  const f = await fixture(), hostFile = path.join(f.directory, 'host.json');
  const base = {format:'strata-studio-host/1', public_origin:'https://studio.example.test', trusted_proxy_addresses:['127.0.0.1'], port:4174,
    connection_config:path.resolve(f.directory, '..', 'synthetic-connection.json'), expected_repository_id:pin};
  await writeFile(hostFile, JSON.stringify(base)); await assert.rejects(loadHostedConfig(hostFile));
  await writeFile(hostFile, JSON.stringify({...base, read_budget_file:f.file}));
  assert.equal((await loadHostedConfig(hostFile)).config.read_budget_file, f.file);
  for (const budgetFile of [base.connection_config, 'relative.json', f.directory + path.sep + '..' + path.sep + 'bad.json']) {
    await writeFile(hostFile, JSON.stringify({...base, read_budget_file:budgetFile})); await assert.rejects(loadHostedConfig(hostFile));
  }
  await writeFile(hostFile, JSON.stringify({...base, read_budget_file:f.file, browser_owner:{
    control_file:path.resolve(f.directory, '..', 'control.json'), state_directory:f.directory,
    key_directory:path.resolve(f.directory, '..', 'keys'), credential_directory:path.resolve(f.directory, '..', 'credentials')}}));
  await assert.rejects(loadHostedConfig(hostFile));
});
