import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { namespaceFixture } from './namespace-fixture.js';
import { canonical, digest } from '../src/model.js';
import { PROFILE_OPERATIONS } from '../src/build-records.js';
import { BUILD_OPERATIONS } from '../src/build-operations.js';
import { initialWorkspaceState } from '../src/explorer/workspace-state.js';
import { writePrivate } from '../src/explorer/owner-files.js';

test('namespace factory mounts opt-in Profiles and host Local Build through existing owner actor routes, keeps absent configuration unsupported',
 {skip:process.platform!=='win32'&&process.getuid?.()!==0},async t=>{
  const f=await namespaceFixture();t.after(()=>f.server.close());await f.prepare();
  const created=await f.action('create',{name:'local-build-mount',purpose:'Synthetic mount test'});assert.equal(created.status,200,created.text);
  const project=created.data.projects[0],headers={'x-strata-repository':project.id};
  let actor=await f.b.send('/studio/actor/session','POST',{},f.csrf);assert.equal(actor.status,200,actor.text);
  let caps=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);
  assert.equal(caps.data.data.operations.find((o:any)=>o.operation==='build.start').configured,false);
  await f.server.close();
  // A new, explicitly sealed synthetic writer genesis. This fixture does not
  // qualify an in-place upgrade, real custody, grants or a production migration.
  const root=path.join(f.config.projects_directory,digest({repository_id:project.id}));
  const manifest=JSON.parse(await readFile(path.join(root,'genesis.json'),'utf8')),registry=JSON.parse(await readFile(path.join(root,'broker','registry.json'),'utf8'));
  const record_bytes:Record<string,string>={};
  for(const [ref,e] of Object.entries(registry.entries) as [string,any][])record_bytes[ref]=await readFile(path.join(root,'broker','verified-artifacts',e.hash+'.json'),'utf8');
  manifest.policy={...manifest.policy,format:'strata-host-policy/4',generation:2,grants:manifest.policy.grants.map((g:any)=>({...g,
    operations:[...new Set([...g.operations,...PROFILE_OPERATIONS,...BUILD_OPERATIONS,'materialize','realization.register','evidence.run'])],profiles:['collection-host/1'],build_repository_ids:[project.id]}))};
  manifest.profiles={authority_ref:'ProjectBaseline@1'};
  const imported={...manifest.imported,format:'strata-studio-owner-snapshot/1',complete_private_state:false,source_writer:'synthetic-reviewed-mount',source_generation:digest(registry),
    closure_verification:{kind:'owner-approved-snapshot',receipt_sha256:digest('synthetic-only')},record_bytes,
    registry:{entries:registry.entries,storage:registry.storage,heads:{},requests:{},contexts:{}}};
  manifest.imported=imported;manifest.grant.import_manifest_sha256=digest(imported);manifest.grant.actor_binding_sha256=digest({accounts:manifest.accounts,policy:manifest.policy});
  await writePrivate(path.join(root,'genesis.json'),manifest);
  await writePrivate(path.join(root,'broker','registry.json'),imported.registry);
  const control=initialWorkspaceState(manifest.grant,digest(imported.origin));control.desired_connected=true;
  await writePrivate(path.join(root,'control','workspace.json'),control);
  const catalogFile=path.join(f.config.catalog_directory,'namespace.json'),catalog=JSON.parse(await readFile(catalogFile,'utf8'));
  catalog.projects.find((p:any)=>p.id===project.id).genesis_sha256=digest(manifest);await writePrivate(catalogFile,catalog);
  const temporary=await mkdtemp(path.join(tmpdir(),'strata-namespace-host-output-')),output=path.join(temporary,'output');await mkdir(output,{mode:0o700});
  await f.restart({output:{id:'test-host-output',label:'Synthetic Studio host',root:output,excluded_roots:[f.base.root,process.cwd()],
    protection:async()=>({safe:true,fingerprint:digest('synthetic-custody-only')})}},true);
  await f.login();actor=await f.b.send('/studio/actor/session','POST',{},f.csrf);assert.equal(actor.status,200,actor.text);
  caps=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);assert.equal(caps.status,200,caps.text);
  for(const command of ['profile.create','build.prepare','build.start']) {
    const row=caps.data.data.operations.find((o:any)=>o.operation===command);assert.equal(row.configured,true,canonical(row));assert.equal(row.allowed,true,canonical(row));assert.equal(row.supported,true,canonical(row));
  }
  const profiles=await f.b.send('/studio/v1/profiles','GET',undefined,undefined,headers);assert.equal(profiles.status,200,profiles.text);assert.deepEqual(profiles.data.data.profiles,[]);
  const context=await f.b.send('/studio/v1/build/context','GET',undefined,undefined,headers);assert.equal(context.status,200,context.text);
  assert.equal(context.data.data.destinations[0].kind,'local');assert.equal(context.data.data.destinations[0].host.slot_id,'test-host-output');
  assert.equal(context.data.data.destinations[0].host.verify,true);assert.equal(context.data.data.destinations[1].supported,false);
  assert.equal(context.data.data.run_application,false);assert.equal(context.data.data.serve_application,false);
  assert.ok(context.data.data.excluded.some((r:any)=>r.code==='BUILD_BOOTSTRAP_EXCLUDED'));
  const wrong=await f.b.send('/studio/v1/build/context','GET',undefined,undefined,{'x-strata-repository':'other'});assert.equal(wrong.status,403);
  await f.restart({repository_ids:['explicit-other-repository'],output:{id:'test-host-output',label:'Synthetic Studio host',root:output,excluded_roots:[f.base.root,process.cwd()],
    protection:async()=>({safe:true,fingerprint:digest('synthetic-custody-only')})}});
  await f.login();actor=await f.b.send('/studio/actor/session','POST',{},f.csrf);assert.equal(actor.status,200,actor.text);
  caps=await f.b.send('/studio/v1/capabilities','GET',undefined,undefined,headers);
  assert.equal(caps.data.data.operations.find((o:any)=>o.operation==='build.start').configured,false);
  assert.equal(caps.data.data.operations.find((o:any)=>o.operation==='profile.create').configured,true);
 });
