import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from '../src/model.js';
import { FileWorkspaceBudget, initialWorkspaceBudget } from '../src/explorer/workspace-budget.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { workspaceGrant,carriedUsage } from './workspace-fixture.js';
async function fixture(){const dir=await mkdtemp(path.join(process.env.STRATA_TEST_TMP??tmpdir(),'strata-workspace-budget-'));await chmod(dir,0o700);const file=path.join(dir,'budget.json'),g=workspaceGrant(),o=carriedUsage();await writePrivate(file,initialWorkspaceBudget(g,o),true);return {dir,file,g,o,budget:()=>new FileWorkspaceBudget(file,g,o)};}
const code=(c:string)=>(e:any)=>e.code===c;
test('full binding, carried spending, cold recreation and snapshot are durable and read only',async()=>{
 const f=await fixture();const before=await readFile(f.file,'utf8');assert.deepEqual((await f.budget().snapshot()).reserved,{requests:12,bytes:393020});assert.equal(await readFile(f.file,'utf8'),before);
 await f.budget().reserve(randomUUID(),digest('op'),'file.read',20);assert.deepEqual((await f.budget().snapshot()).reserved,{requests:13,bytes:393040});
 const changed=structuredClone(f.g);changed.policy_generation++;await assert.rejects(new FileWorkspaceBudget(f.file,changed,f.o).ready(),code('WORKSPACE_ACCOUNTING_UNAVAILABLE'));
 assert.deepEqual((await f.budget().snapshot()).reserved,{requests:13,bytes:393040});
});
test('reservation is never a replayable dispatch permit or refundable count',async()=>{
 const f=await fixture(),id=randomUUID(),operation=digest('op');await f.budget().reserve(id,operation,'token.issue',21);
 await assert.rejects(f.budget().reserve(id,operation,'token.issue',21),code('WORKSPACE_DISPATCH_REPLAY'));
 await assert.rejects(f.budget().reserve(id,operation,'token.issue',22),code('WORKSPACE_DISPATCH_REPLAY'));
 assert.deepEqual((await f.budget().snapshot()).reserved,{requests:13,bytes:393041});
});
test('both cap boundaries refuse before dispatch and retain exact spent reservations',async()=>{
 const f=await fixture();f.g.limits.requests=13;f.g.limits.bytes=393030;await writePrivate(f.file,initialWorkspaceBudget(f.g,f.o));
 await f.budget().reserve(randomUUID(),digest('op'),'file.read',10);
 await assert.rejects(f.budget().reserve(randomUUID(),digest('op'),'file.read',1),code('WORKSPACE_BUDGET_EXHAUSTED'));
 assert.deepEqual((await f.budget().snapshot()).remaining,{requests:0,bytes:0});
});
test('missing/corrupt/stale lease never initializes, resets or reclaims state',async()=>{
 const f=await fixture();await unlink(f.file);await assert.rejects(f.budget().ready(),code('WORKSPACE_ACCOUNTING_UNAVAILABLE'));
 await writeFile(f.file,'{}',{mode:0o600});await assert.rejects(f.budget().snapshot(),code('WORKSPACE_ACCOUNTING_UNAVAILABLE'));
 await writePrivate(f.file,initialWorkspaceBudget(f.g,f.o));await writeFile(path.join(f.dir,'.owner.lock'),'interrupted',{mode:0o600});
 await assert.rejects(f.budget().ready(),code('WORKSPACE_ACCOUNTING_UNAVAILABLE'));assert.equal(await readFile(path.join(f.dir,'.owner.lock'),'utf8'),'interrupted');
});
test('concurrent reservations cannot overspend one remaining request',async()=>{
 const f=await fixture();f.g.limits.requests=13;await writePrivate(f.file,initialWorkspaceBudget(f.g,f.o));
 const r=await Promise.allSettled([f.budget().reserve(randomUUID(),digest('a'),'file.read',10),f.budget().reserve(randomUUID(),digest('b'),'file.read',10)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.budget().snapshot()).reserved.requests,13);
});
