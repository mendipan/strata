import path from 'node:path';
import { BLOCK_MODEL, fail, parse } from '../model.js';
import type { HostIssuer } from '../auth/host-issuer.js';
import type { SecurityContext } from '../security.js';
import { BUILD_OPERATIONS } from '../build-operations.js';
import { PROFILE_OPERATIONS } from '../build-records.js';
import { createBuildRepository, type BuildRepositoryConfig } from '../build-repository-core.js';
import { LocalBuildStudioAdapter, studioRequestSchema, type ProfilesBuildStudioPort } from '../build-studio.js';
import { LocalBuildOutput, type OutputSlot } from '../build-output.js';
import { currentBuildHost, type HostEnvironment } from '../build-host.js';

/** Installation configuration only. Never decoded from a browser command or
 * synthesized by owner login. Custody qualification and activation are separate.
 */
export type NamespaceLocalBuildConfiguration = {
  output: OutputSlot;
  // Explicit launcher scope. Existing trusted composition callers may omit it.
  repository_ids?: readonly string[];
  host?: () => Promise<HostEnvironment>;
  // A host may provide its already configured scoped recovery actor at startup.
  // The mount creates no account, policy or grant for recovery.
  startupRecovery?: (repository_id: string, issuer: HostIssuer) => Promise<SecurityContext>;
};
function contains(root: string, target: string) {
  const relative=path.relative(path.resolve(root),path.resolve(target));
  return !relative || relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
export function namespaceBuildOutput(configuration: NamespaceLocalBuildConfiguration, protectedRoots: readonly string[]) {
  if(protectedRoots.some(target=>!configuration.output.excluded_roots.some(root=>contains(root,target))))
    fail('OUTPUT_ROOT_UNSAFE',4,'Local Build exclusions must contain the complete namespace installation storage and asset inventory.');
  return new LocalBuildOutput(configuration.output);
}
/** Uses the existing sole namespace writer; opens no registry, database or lease. */
export function createNamespaceBuildRepository(config: BuildRepositoryConfig & { model_version: string }) {
  if(config.model_version!==BLOCK_MODEL || config.scope.source_trust!=='host-authenticated')
    fail('UNSUPPORTED_HOSTED_AUTHORITY',8,'Namespace Local Build requires an explicitly configured authenticated v0.3 repository.');
  const repository=createBuildRepository(config);
  let startupChecked=false;
  return { ...repository, execute:async(command:string,input:unknown,context:SecurityContext,options?:Parameters<typeof repository.execute>[3])=>{
    if(command==='build.start'&&!options?.dry_run&&!startupChecked) {
      await config.transaction(context,'build.inspect',{}, {dry_run:true},async(engine,registry)=>{
        config.issuer.authorize(context,'build.inspect',{},engine);
        config.issuer.assertRepository(context,'build.inspect',config.scope.repository_id,[]);
        const original=options?.key&&registry.requests[context.tenant_id+':'+context.project_id+':'+context.principal_id+':'+options.key];
        const heads=new Map<string,any>();
        for(const r of Object.values(engine.records))if(r.type==='build-attempt-revision'&&r.data.repository_id===config.scope.repository_id) {
          const old=heads.get(r.data.run.build_id);if(!old||old.revision<r.data.revision)heads.set(r.data.run.build_id,r.data);
        }
        const pending=[...heads.values()].some(r=>!['completed','failed','interrupted','output_incomplete'].includes(r.run.phase));
        if(pending&&!original)fail('BUILD_RECOVERY_REQUIRED',9,'A retained attempt needs explicit stopped-host reconciliation before a fresh Build request.');
        if(!pending)startupChecked=true;
        return {data:undefined};
      });
    }
    return repository.execute(command,input,context,options);
  } };

}
export function namespaceBuildHost(configuration: NamespaceLocalBuildConfiguration) {
  // The built-in finite runner is used by the shared coordinator. Explicitly
  // supplying this configuration selects that runner; no PATH/plugin is loaded.
  return configuration.host??(async()=>currentBuildHost('Studio host',{id:'finite-node',profile_ids:['collection-host/1']}));
}
/** Existing profile port and Local Build share one actor and namespace broker. */
export function namespaceBuildStudioPort(repository: ReturnType<typeof createNamespaceBuildRepository>, context:()=>SecurityContext,
  profiles:ProfilesBuildStudioPort, beforeStart:()=>Promise<void>):ProfilesBuildStudioPort {
  const builds=new LocalBuildStudioAdapter(repository,context);
  const supported=(command:string)=>BUILD_OPERATIONS.includes(command as any);
  return {
    repository:{repository_id:repository.repository_id},
    supports:command=>supported(command)||PROFILE_OPERATIONS.includes(command as any)&&(!profiles.supports||profiles.supports(command)),
    read:(command,input)=>supported(command)?builds.read(command,input):profiles.read(command,input),
    operation:async value=>{
      // LocalBuildStudioAdapter parses the strict existing request schema.
      const request=parse(studioRequestSchema,value);
      if(request.command==='build.start'&&!request.dry_run)await beforeStart();
      return supported(request.command)?builds.operation(request):profiles.operation(request);
    },
    download:(build,file)=>builds.download(build,file),
  };
}
