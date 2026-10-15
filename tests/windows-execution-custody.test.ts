import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { LocalExecutionStorage } from '../src/agent-adapters/local-execution-storage.js';
import { assertWindowsCustody, WindowsExecutionCustodyError, type WindowsCustodyReason } from '../src/agent-adapters/windows-execution-custody.js';
import { queryWindowsCustody, type WindowsCustodyRequest } from '../src/agent-adapters/windows-execution-custody-query.js';
import { createWindowsCustodyFixture } from './fixtures/windows-execution-custody.js';

const windows = { skip: process.platform !== 'win32' };
const binding = { role: 'host' as const, owner_id: 'fixture-owner', connection_id: 'fixture-connection' };
function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-windows-custody-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^strata-windows-custody-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
const rejected = (reason: WindowsCustodyReason, entry?: string) => (error: unknown) => {
  assert.ok(error instanceof WindowsExecutionCustodyError);
  assert.equal(error.code, 'EXECUTION_UNAVAILABLE'); assert.equal(error.reason, reason);
  if (entry) assert.equal(error.entry, entry);
  assert.doesNotMatch(error.message, /secret|execution\.json|C:\\|raw helper/);
  assert.equal(error.cause, undefined); return true;
};
function storage(directory: string, callback = assertWindowsCustody) {
  return new LocalExecutionStorage(directory, binding, { assertWindowsCustody: callback });
}
const processSid = 'S-1-5-21-100-200-300-1001';
function syntheticResponse(request: WindowsCustodyRequest) {
  return { version: 1, nonce: request.nonce, processSid, items: request.paths.map((filename, index) => {
    const stat = fs.lstatSync(filename, { bigint: true });
    return { requestedPath: filename, finalPath: '\\\\?\\' + filename,
      fileId: stat.ino.toString(16).padStart(16, '0'), volume: Number(stat.dev),
      attributes: index === 0 ? 16 : 128, links: Number(stat.nlink), ownerSid: processSid,
      revision: 1, control: index === 0 ? 0x9004 : 0x8404, aclRevision: 2,
      aces: [{ type: 0, flags: index === 0 ? 3 : 16, mask: 0x1f01ff, sid: processSid, callback: false }] };
  }) };
}
type SyntheticResponse = ReturnType<typeof syntheticResponse>;
// Mock ONLY the metadata subprocess transport. Actual callback/storage/link and
// staging code runs. These cases make no claim about native Windows ACLs.
function mockQuery(t: test.TestContext, edit: (response: SyntheticResponse, request: WindowsCustodyRequest) => unknown) {
  const original = childProcess.execFile;
  childProcess.execFile = ((_file: unknown, _args: unknown, _options: unknown, done: Function) => ({
    stdin: { on: () => {}, end: (input: string) => {
      const request = JSON.parse(input) as WindowsCustodyRequest;
      queueMicrotask(() => {
        try {
          const output = edit(syntheticResponse(request), request);
          if (output instanceof Error) done(output, Buffer.alloc(0), Buffer.alloc(0));
          else done(null, Buffer.isBuffer(output) ? output : Buffer.from(JSON.stringify(output)), Buffer.alloc(0));
        } catch (error) { done(error, Buffer.alloc(0), Buffer.alloc(0)); }
      });
    } },
  })) as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
}

test('native Windows: private creation, inherited journal/lease/stage metadata, restart and exact path binding', windows, async t => {
  const root = temporary(t), directory = path.join(root, "private ' $(secret) ; [data] é");
  createWindowsCustodyFixture(root, directory);
  let calls = 0, staged = false;
  const s = storage(directory, async actual => {
    calls++; assert.equal(actual, directory);
    if (fs.readdirSync(actual).some(name => name.startsWith('execution.json.'))) {
      assert.ok(fs.existsSync(path.join(actual, '.owner.lock'))); staged = true;
    }
    await assertWindowsCustody(actual);
  });
  await s.provisionEmpty();
  await s.transaction(tx => tx.put('private', { value: 'fixture journal prose' }));
  assert.ok(staged); assert.equal(calls, 4);
  const before = fs.readFileSync(path.join(directory, 'execution.json'));
  assert.deepEqual(await storage(directory).transaction(tx => tx.get('private')), { value: 'fixture journal prose' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'execution.json')), before);
  assert.deepEqual(fs.readdirSync(directory), ['execution.json']);
  const result = JSON.parse((await queryWindowsCustody({ version: 1,
    nonce: '11111111-1111-4111-8111-111111111111', paths: [directory, path.join(directory, 'execution.json')] })).toString());
  assert.equal(result.items[0].ownerSid, result.processSid);
  assert.ok(result.items[1].aces.some((ace: { flags: number }) => ace.flags & 16));
});

test('native Windows: unsafe directory access and inherit-only ordinary-principal file access refuse before provisioning', windows, async t => {
  const root = temporary(t);
  for (const inheritOnly of [false, true]) {
    const directory = path.join(root, inheritOnly ? 'unsafe-inheritance' : 'unsafe-access');
    createWindowsCustodyFixture(root, directory, 'directory', true, inheritOnly);
    await assert.rejects(storage(directory).provisionEmpty(), rejected('access', 'directory'));
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('native Windows: a newly created unsafe staged file refuses and preserves committed history', windows, async t => {
  const root = temporary(t), directory = path.join(root, 'private');
  createWindowsCustodyFixture(root, directory);
  await storage(directory).provisionEmpty();
  await storage(directory).transaction(tx => tx.put('committed', 'keep'));
  const before = fs.readFileSync(path.join(directory, 'execution.json')); let replaced = false;
  const s = storage(directory, async actual => {
    const stage = fs.readdirSync(actual).find(name => name.startsWith('execution.json.'));
    if (stage) {
      const filename = path.join(actual, stage);
      fs.unlinkSync(filename); // Disposable unpublished stage only; no ACL edits.
      createWindowsCustodyFixture(root, filename, 'file', true); replaced = true;
    }
    await assertWindowsCustody(actual);
  });
  await assert.rejects(s.transaction(tx => tx.put('uncommitted', 'discard')), rejected('access', 'stage'));
  assert.ok(replaced); assert.deepEqual(fs.readFileSync(path.join(directory, 'execution.json')), before);
  assert.deepEqual(fs.readdirSync(directory), ['execution.json']);
  assert.equal(await storage(directory).transaction(tx => tx.get('uncommitted')), undefined);
});

test('native Windows: unsafe pre-existing journal and lease files refuse independently of private parent', windows, async t => {
  const root = temporary(t);
  for (const [filename, entry] of [['execution.json', 'journal'], ['.owner.lock', 'lease']] as const) {
    const directory = path.join(root, entry); createWindowsCustodyFixture(root, directory);
    const file = path.join(directory, filename); createWindowsCustodyFixture(root, file, 'file', true);
    await assert.rejects(storage(directory).transaction(async () => {}), rejected('access', entry));
    assert.equal(fs.statSync(file).size, 0); assert.deepEqual(fs.readdirSync(directory), [filename]);
  }
});

test('native Windows: actual hardlinks and junction paths refuse through the existing link fences', windows, async t => {
  const root = temporary(t), directory = path.join(root, 'private');
  createWindowsCustodyFixture(root, directory);
  await storage(directory).provisionEmpty();
  const before = fs.readFileSync(path.join(directory, 'execution.json'));
  const hardlink = path.join(root, 'hardlink');
  fs.linkSync(path.join(directory, 'execution.json'), hardlink);
  await assert.rejects(assertWindowsCustody(directory), rejected('path', 'journal'));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'execution.json')), before);
  fs.unlinkSync(hardlink);
  const junction = path.join(root, 'junction');
  fs.symlinkSync(directory, junction, 'junction');
  await assert.rejects(assertWindowsCustody(junction), rejected('path'));
  fs.unlinkSync(junction);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'execution.json')), before);
});

test('mocked metadata: wrong owner, other grants and unsupported/incomplete semantics refuse before use', windows, async t => {
  const cases: [string, WindowsCustodyReason, (response: SyntheticResponse) => void][] = [
    ['owner', 'owner', r => { r.items[0].ownerSid = 'S-1-5-21-100-200-300-1002'; }],
    ['world', 'access', r => { r.items[0].aces.push({ ...r.items[0].aces[0], sid: 'S-1-1-0' }); }],
    ['admin group', 'access', r => { r.items[0].aces.push({ ...r.items[0].aces[0], sid: 'S-1-5-32-544' }); }],
    ['null dacl', 'descriptor', r => { r.items[0].control = 0x8000; }],
    ['empty dacl', 'inheritance', r => { r.items[0].aces = []; }],
    ['object ace', 'descriptor', r => { r.items[0].aces[0].type = 5; }],
    ['callback ace', 'descriptor', r => { r.items[0].aces[0].callback = true; }],
    ['deny ace', 'descriptor', r => { r.items[0].aces[0].type = 1; }],
    ['unknown flags', 'descriptor', r => { r.items[0].aces[0].flags = 64; }],
    ['unknown rights', 'descriptor', r => { r.items[0].aces[0].mask = 0x02000000; }],
    ['defaulted', 'descriptor', r => { r.items[0].control |= 8; }],
    ['no file inheritance', 'inheritance', r => { r.items[0].aces[0].flags = 2; }],
    ['inherit only', 'inheritance', r => { r.items[0].aces[0].flags = 9; }],
    ['incomplete control', 'descriptor', r => { r.items[0].control |= 0x100; }],
  ];
  for (const [name, reason, edit] of cases) await t.test(name, async t => {
    const directory = temporary(t); mockQuery(t, r => { edit(r); return r; });
    await assert.rejects(storage(directory).provisionEmpty(), rejected(reason));
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('mocked metadata: unavailable, malformed, oversized and incorrectly bound responses are closed refusals', windows, async t => {
  const cases: [string, WindowsCustodyReason, (r: SyntheticResponse) => unknown][] = [
    ['unavailable', 'query', () => new Error('raw helper secret')],
    ['malformed', 'response', () => Buffer.from('{ raw helper secret')],
    ['invalid UTF-8', 'response', () => Buffer.from([0xff])],
    ['oversized', 'query', () => Buffer.alloc(256 * 1024 + 1)],
    ['extra field', 'response', r => ({ ...r, secret: true })],
    ['missing records', 'response', r => ({ ...r, items: [] })],
    ['nonce', 'response', r => ({ ...r, nonce: '22222222-2222-4222-8222-222222222222' })],
    ['path mismatch', 'path', r => { r.items[0].requestedPath += 'other'; return r; }],
    ['final path mismatch', 'path', r => { r.items[0].finalPath += 'other'; return r; }],
    ['identity mismatch', 'path', r => { r.items[0].fileId = '0000000000000001'; return r; }],
    ['volume mismatch', 'path', r => { r.items[0].volume++; return r; }],
    ['reparse', 'path', r => { r.items[0].attributes |= 0x400; return r; }],
  ];
  for (const [name, reason, edit] of cases) await t.test(name, async t => {
    const directory = temporary(t); mockQuery(t, edit);
    await assert.rejects(storage(directory).provisionEmpty(), rejected(reason));
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('mocked metadata: custody changes after staging reject the write and preserve exact committed history', windows, async t => {
  const directory = temporary(t); let fail = false, sawStage = false;
  mockQuery(t, (r, request) => {
    const index = request.paths.findIndex(filename => path.basename(filename).startsWith('execution.json.'));
    if (fail && index > 0) { r.items[index].ownerSid = 'S-1-5-21-100-200-300-1002'; sawStage = true; }
    return r;
  });
  const s = storage(directory); await s.provisionEmpty();
  await s.transaction(tx => tx.put('committed', 'keep'));
  const before = fs.readFileSync(path.join(directory, 'execution.json')); fail = true;
  await assert.rejects(s.transaction(tx => tx.put('uncommitted', 'discard')), rejected('owner', 'stage'));
  assert.ok(sawStage); assert.deepEqual(fs.readFileSync(path.join(directory, 'execution.json')), before);
  assert.deepEqual(fs.readdirSync(directory), ['execution.json']); fail = false;
  assert.equal(await storage(directory).transaction(tx => tx.get('uncommitted')), undefined);
});

test('mocked metadata: unprotected inherited file custody and stable directory membership are required', windows, async t => {
  for (const mode of ['protected', 'explicit', 'changed']) await t.test(mode, async t => {
    const directory = temporary(t); fs.writeFileSync(path.join(directory, '.owner.lock'), 'fixture');
    mockQuery(t, r => {
      if (mode === 'protected') r.items[1].control |= 0x1000;
      else if (mode === 'explicit') r.items[1].aces[0].flags = 0;
      else fs.writeFileSync(path.join(directory, 'execution.json'), 'new membership');
      return r;
    });
    await assert.rejects(assertWindowsCustody(directory), rejected(mode === 'changed' ? 'changed' : 'inheritance'));
  });
});
