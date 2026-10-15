import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, lstat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadHostedConfig, hostedConfigSchema } from '../scripts/studio-host.js';
import { namespaceLocalBuildHostSchema, namespaceLocalBuildInstallation } from '../src/explorer/namespace-build-installation.js';
import { namespaceBuildOutput, namespaceBuildHost } from '../src/explorer/namespace-build.js';

test('launcher accepts only explicit namespace Build inventory; owner/login, runtime, recovery and platform selectors cannot supply configuration',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'strata-launcher-config-')),
    owner={control_file:path.join(root,'control.json'),state_directory:path.join(root,'owner'),key_directory:path.join(root,'keys'),credential_directory:path.join(root,'credentials')},
    namespace={policy_file:path.join(root,'namespace.json'),catalog_directory:path.join(root,'catalog'),projects_directory:path.join(root,'projects')},
    build={format:'strata-namespace-local-build-host/1',repository_ids:['synthetic-repository'],output:{id:'local-output',label:'Private Studio output',root:path.join(root,'output'),excluded_roots:[root]}},
    base={format:'strata-studio-host/1',public_origin:'https://studio.example.test',trusted_proxy_addresses:['127.0.0.1'],port:3000,browser_owner:owner,namespace};
  assert.ok(hostedConfigSchema.safeParse({...base,namespace_local_build:build}).success);
  const file=path.join(root,'host.json');await writeFile(file,JSON.stringify(base));
  assert.equal((await loadHostedConfig(file)).config.namespace_local_build,undefined);
  await writeFile(file,JSON.stringify({...base,namespace_local_build:build}));
  assert.deepEqual((await loadHostedConfig(file)).config.namespace_local_build,build);
  await assert.rejects(lstat(build.output.root),(e:any)=>e.code==='ENOENT');
  for(const extra of [{command:'arbitrary'},{runtime:'/untrusted/node'},{startupRecovery:'owner'},{uid:42},{protection:{safe:true}},{destination:'cloudflare-worker'}])
    assert.equal(namespaceLocalBuildHostSchema.safeParse({...build,...extra}).success,false);
  assert.equal(namespaceLocalBuildHostSchema.safeParse({...build,repository_ids:[]}).success,false);
  assert.equal(namespaceLocalBuildHostSchema.safeParse({...build,repository_ids:['same','same']}).success,false);
  assert.equal(namespaceLocalBuildHostSchema.safeParse({...build,output:{...build.output,root:'relative'}}).success,false);
  await writeFile(file,JSON.stringify({...base,namespace:undefined,namespace_local_build:build}));
  await assert.rejects(loadHostedConfig(file),/requires namespace mode/);
  if(process.platform!=='linux')assert.throws(()=>namespaceLocalBuildInstallation(build,[root]),(e:any)=>e.code==='OUTPUT_PROTECTION_UNSUPPORTED');
});

test('Linux launcher uses current service identity, refuses absent or unprotected storage, links and incomplete inventory without provisioning it',
  {skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'strata-native-build-custody-'));await chmod(root,0o700);
  const output=path.join(root,'output'),protectedRoot=path.join(root,'source');await mkdir(protectedRoot,{mode:0o700});
  const build={format:'strata-namespace-local-build-host/1',repository_ids:['synthetic-repository'],output:{id:'local-output',label:'Disposable Linux fixture',root:output,excluded_roots:[protectedRoot]}};
  const installation=namespaceLocalBuildInstallation(build,[protectedRoot]),adapter=namespaceBuildOutput(installation,[protectedRoot]);
  const before=await readdir(root);await assert.rejects(adapter.preflight());assert.deepEqual(await readdir(root),before);
  await mkdir(output,{mode:0o700});assert.ok((await adapter.preflight()).identity);
  const host=await namespaceBuildHost(installation)();assert.equal(host.node_version,process.version);assert.deepEqual(host.runner?.profile_ids,['collection-host/1']);
  await chmod(output,0o755);await assert.rejects(adapter.preflight(),(e:any)=>e.code==='OUTPUT_ROOT_UNSAFE');await chmod(output,0o700);
  assert.throws(()=>namespaceLocalBuildInstallation(build,[path.join(root,'unlisted')]),(e:any)=>e.code==='OUTPUT_ROOT_UNSAFE');
  const linked=path.join(root,'link');await symlink(output,linked);const throughLink=namespaceLocalBuildInstallation({...build,output:{...build.output,root:linked}},[protectedRoot]);
  await assert.rejects(namespaceBuildOutput(throughLink,[protectedRoot]).preflight(),(e:any)=>e.code==='OUTPUT_ROOT_UNSAFE');
});
