import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit, gitPins, captureGitSource, requireCleanGit, gitPath, uniqueGitPaths, decodeGit, worktreeBytes } from '../src/git-workspace.js';
import { stageGitPatch, parseGitPatch } from '../src/git-patch.js';
import { StrataError, bytesDigest } from '../src/model.js';
const error = (code: string) => (e: unknown) => e instanceof StrataError && e.code === code;
export async function syntheticGit(format = 'sha1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-git-fixture-')), sandbox = await mkdtemp(path.join(os.tmpdir(), 'strata-git-stages-'));
  await runGit(root, ['init', '--quiet', '--object-format=' + format]);
  await runGit(root, ['config', 'user.name', 'Synthetic Fixture']); await runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(root, 'counter.mjs'), 'export const maximum = 6;\nexport const preserved = true;\n');
  await writeFile(path.join(root, 'unrelated.txt'), 'unchanged\n'); await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 255, 17]));
  await runGit(root, ['add', '--', '.']); await runGit(root, ['commit', '--quiet', '-m', 'Synthetic baseline']);
  return { host: { projectId:'strata-local-demo', repoId: 'synthetic-app', root }, sandbox, pins: await gitPins({ projectId:'strata-local-demo', repoId: 'synthetic-app', root }) };
}
export const patch = 'diff --git a/counter.mjs b/counter.mjs\n--- a/counter.mjs\n+++ b/counter.mjs\n@@ -1,2 +1,2 @@\n-export const maximum = 6;\n+export const maximum = 12;\n export const preserved = true;\n';
test('private patch staging preserves original files, HEAD, index and refs in SHA1 and SHA256 repositories', async () => {
  for (const format of ['sha1', 'sha256']) {
    const f = await syntheticGit(format), before = await readFile(path.join(f.host.root, 'counter.mjs')), refs = await runGit(f.host.root, ['show-ref']);
    const captured = await captureGitSource(f.host, {format:'source-scope/1',coverage:'selected-scope',paths:['counter.mjs'],watch_roots:[],exclusions:[],items:['counter/purpose'],mapping:[{item:'counter/purpose',paths:['counter.mjs'],criteria:[]}],limitations:[]}, { mode: 'baseline' });
    assert.equal(captured.snapshot.entries[0].sha256, bytesDigest(before));
    const stage = await stageGitPatch(f.host, f.pins, ['counter.mjs'], patch, f.sandbox);
    assert.equal(stage.operations[0].after.content, 'export const maximum = 12;\nexport const preserved = true;\n');
    assert.deepEqual(await gitPins(f.host), f.pins); assert.deepEqual(await readFile(path.join(f.host.root, 'counter.mjs')), before); assert.deepEqual(await runGit(f.host.root, ['show-ref']), refs);
    assert.deepEqual(await readFile(path.join(f.host.root, 'image.bin')), Buffer.from([0, 255, 17]));
  }
});
test('dirty staged, unstaged, untracked and changed exact bases refuse preparation', async () => {
  const f = await syntheticGit();
  await writeFile(path.join(f.host.root, 'unrelated.txt'), 'dirty\n'); await assert.rejects(requireCleanGit(f.host), error('UNSUPPORTED_CHECKOUT_TRANSFORM'));
  await runGit(f.host.root, ['add', '--', 'unrelated.txt']); await assert.rejects(requireCleanGit(f.host), error('DIRTY_GIT_WORKTREE'));
  await runGit(f.host.root, ['commit', '--quiet', '-m', 'Owner change']); await assert.rejects(requireCleanGit(f.host, f.pins), error('STALE_SOURCE'));
  await writeFile(path.join(f.host.root, 'untracked.txt'), 'untouched'); await assert.rejects(requireCleanGit(f.host), error('DIRTY_GIT_WORKTREE'));
});
test('patch scope, conflicts, binary, rename, zero context, aliases and malformed hunks fail closed', async () => {
  const f = await syntheticGit();
  await assert.rejects(stageGitPatch(f.host, f.pins, ['unrelated.txt'], patch, f.sandbox), error('PATCH_SCOPE'));
  await assert.rejects(stageGitPatch(f.host, f.pins, ['counter.mjs'], patch.replace('maximum = 6', 'maximum = 7'), f.sandbox), error('PATCH_CONFLICT'));
  for (const text of [patch + patch, patch.replace('a/counter.mjs b/counter.mjs', 'a/counter.mjs b/new.mjs'), patch.replace('@@ -1,2 +1,2 @@', '@@ -1,1 +1,1 @@'), 'diff --git a/x b/x\nGIT binary patch\n', patch.replace(' export const preserved = true;\n', '')]) assert.throws(() => parseGitPatch(text));
  for (const name of ['../x', '/x', 'C:/x', 'a\\b', '.git/config', 'CON', 'a/../b', 'a:b', 'a.', 'a//b']) assert.throws(() => gitPath(name), error('INVALID_PATH'));
  assert.deepEqual(await gitPins(f.host), f.pins);
});
test('clean Git CRLF transformations, hidden index flags and links are refused without invoking source programs', async () => {
  const f = await syntheticGit();
  await writeFile(path.join(f.host.root, 'counter.mjs'), 'export const maximum = 6;\r\nexport const preserved = true;\r\n');
  await assert.rejects(requireCleanGit(f.host), error('UNSUPPORTED_CHECKOUT_TRANSFORM'));
  await writeFile(path.join(f.host.root, 'counter.mjs'), 'export const maximum = 6;\nexport const preserved = true;\n');
  await runGit(f.host.root, ['update-index', '--assume-unchanged', '--', 'counter.mjs']); await assert.rejects(requireCleanGit(f.host), error('UNSUPPORTED_GIT_INDEX'));
});

test('explicit additions and deletions stage against absence and exact raw preimages',async()=>{
  const f=await syntheticGit(),text='diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new source\n'+'diff --git a/unrelated.txt b/unrelated.txt\ndeleted file mode 100644\n--- a/unrelated.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-unchanged\n';
  const staged=await stageGitPatch(f.host,f.pins,['new.txt','unrelated.txt'],text,f.sandbox);assert.equal(staged.operations[0].before.content,null);assert.equal(staged.operations[0].after.content,'new source\n');assert.equal(staged.operations[1].after.content,null);assert.equal(await readFile(path.join(f.host.root,'unrelated.txt'),'utf8'),'unchanged\n');assert.deepEqual(await gitPins(f.host),f.pins);
  assert.throws(()=>uniqueGitPaths(['Src/a.txt','src/b.txt']),error('INVALID_PATH'));
});

test('dirty observation inventories staged additions, watched new paths and deletion separately',async()=>{
  const f=await syntheticGit(),scope={format:'source-scope/1' as const,coverage:'selected-scope' as const,paths:['counter.mjs'],watch_roots:[],exclusions:[],items:['counter/purpose'],mapping:[{item:'counter/purpose',paths:['counter.mjs'],criteria:[]}],limitations:[]};
  await writeFile(path.join(f.host.root,'outside.txt'),'staged outside\n');await runGit(f.host.root,['add','--','outside.txt']);const measured=await captureGitSource(f.host,scope,{mode:'observation'});assert.equal(measured.observation.outside_scope_dirty,true);
  const watched={...scope,watch_roots:['.']};let deniedRead=false;await assert.rejects(captureGitSource(f.host,watched,{mode:'observation',authorizePath:name=>{if(name==='outside.txt'){deniedRead=true;throw new Error('finite grant denied new source');}}}));assert.equal(deniedRead,true);
});

test('Git symlink and submodule modes and physical hardlinks refuse patch adoption',async()=>{
  for(const mode of ['120000','160000']){const f=await syntheticGit(),oid=mode==='160000'?f.pins.head_commit:decodeGit(await runGit(f.host.root,['hash-object','-w','--stdin'],'target.txt')).trim();await runGit(f.host.root,['update-index','--add','--cacheinfo',mode+','+oid+',opaque']);await runGit(f.host.root,['commit','--quiet','-m','Synthetic opaque metadata']);await assert.rejects(requireCleanGit(f.host),error('UNSUPPORTED_GIT_FILE'));}
  const f=await syntheticGit();await link(path.join(f.host.root,'counter.mjs'),path.join(f.sandbox,'hardlink.txt'));await assert.rejects(requireCleanGit(f.host),error('UNSUPPORTED_GIT_FILE'));
});

test('source filter, external diff and hook configurations never run during capture or staging',async()=>{
  const f=await syntheticGit();await writeFile(path.join(f.host.root,'.gitattributes'),'counter.mjs filter=canary\n');await runGit(f.host.root,['add','--','.gitattributes']);await runGit(f.host.root,['commit','--quiet','-m','Synthetic attributes']);const fresh=await gitPins(f.host);
  const marker=path.join(f.sandbox,'must-not-run.txt'),program=path.join(f.sandbox,'canary.cjs');await writeFile(program,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"ran");');const command='node "'+program+'"';await runGit(f.host.root,['config','filter.canary.clean',command]);await runGit(f.host.root,['config','filter.canary.smudge',command]);await runGit(f.host.root,['config','diff.external',command]);await stageGitPatch(f.host,fresh,['counter.mjs'],patch,f.sandbox);await assert.rejects(readFile(marker),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
});

test('junction traversal and nested repository boundaries are refused before target reads or patch writes',async()=>{
  const f=await syntheticGit(),outside=await mkdtemp(path.join(os.tmpdir(),'strata-git-link-target-'));await writeFile(path.join(outside,'secret.txt'),'external target canary');await symlink(outside,path.join(f.host.root,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(worktreeBytes(f.host.root,'linked/secret.txt'),error('INVALID_PATH'));assert.equal(await readFile(path.join(outside,'secret.txt'),'utf8'),'external target canary');
  const g=await syntheticGit();await mkdir(path.join(g.host.root,'nested'));await writeFile(path.join(g.host.root,'nested/file.txt'),'nested ordinary bytes\n');await runGit(g.host.root,['add','--','nested/file.txt']);await runGit(g.host.root,['commit','--quiet','-m','Synthetic nested directory']);await mkdir(path.join(g.host.root,'nested/.git'));await assert.rejects(requireCleanGit(g.host),error('UNSUPPORTED_GIT_FILE'));
});

test('explicit ignored untracked destinations refuse capture instead of measuring their private contents',async()=>{
  const f=await syntheticGit();await writeFile(path.join(f.host.root,'.gitignore'),'private.txt\n');await runGit(f.host.root,['add','--','.gitignore']);await runGit(f.host.root,['commit','--quiet','-m','Synthetic ignore boundary']);await writeFile(path.join(f.host.root,'private.txt'),'ignored-private-canary');const scope={format:'source-scope/1' as const,coverage:'selected-scope' as const,paths:['counter.mjs','private.txt'],watch_roots:[],exclusions:[],items:['counter/purpose'],mapping:[{item:'counter/purpose',paths:['counter.mjs','private.txt'],criteria:[]}],limitations:[]};await assert.rejects(captureGitSource(f.host,scope,{mode:'baseline'}),error('IGNORED_SOURCE_PATH'));await assert.rejects(captureGitSource(f.host,scope,{mode:'observation'}),error('IGNORED_SOURCE_PATH'));assert.equal(await readFile(path.join(f.host.root,'private.txt'),'utf8'),'ignored-private-canary');
});
