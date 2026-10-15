import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rename, appendFile, stat, open } from 'node:fs/promises';
import { renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from './core.js';
import { BLOCK_MODEL, CONTENT_MODEL, MODEL, canonical, digest, bytesDigest, fail, StrataError, type Records } from './model.js';
import { visibleRecords } from './workflow.js';
import { buildRepositoryView } from './build-repository-view.js';
import { executeAuthorized, MUTATIONS } from './service.js';
import { FixtureIssuer, validateEnvelope, auditEvent, MAX_REQUEST_BYTES, type AuthorityIssuer, type SecurityContext, type SafeAuditEvent } from './security.js';
import { commitReferences, type ContextMap } from './recovery.js';
import { loadAssetBytes } from './assets-node.js';
import { bindNodeState, noLinks } from './node-state.js';
import { ArtifactRegistryStore, type LocatedEntry, type StorageBinding } from './artifact-registry.js';
import type { ArtifactLocator } from './artifacts.js';
import { GitNodeAdapter, type GitNodeConfig } from './git-adoption-node.js';
import { adoptionRequired } from './adoption/records.js';
import { describeNativeSupport, nativeOperationSupport, nativeCapabilityFlags } from './native-support.js';
import { APPLICATION_CHECKER } from './git-application-checker.js';
import { startRevalidation,type RevalidationPublication } from './revalidation-node.js';
import { counterRevalidator } from './revalidators/counter.js';
import { normalizeRevalidationRequest,REVALIDATION_SCHEMAS } from './revalidation.js';
import { verifyRetainedRevalidation } from './revalidation-producers.js';
import { HostIssuer } from './auth/host-issuer.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from './build-operations.js';
import { verifyBuildAttempts } from './build-attempt-records.js';
import { PROFILE_OPERATIONS, buildRecordType }  from './build-records.js';
import type { ProfileServiceScope } from './profile-service.js';
import { namespaceProfileService } from './explorer/namespace-profiles.js';
import { validateRecords } from './explorer/validate.js';
import { assertRepositoryStep, assertRepositoryReceipt, type RepositoryStep } from './repository-receipts.js';
import type { WorkspaceBrokerControls, WorkspaceBrokerOperation } from './explorer/workspace-broker.js';

export type Registry = { entries: Record<string, LocatedEntry>; storage?: StorageBinding; asset_locators?: Record<string, ArtifactLocator>; heads: Engine['ownerHeads']; requests: Record<string, { digest: string; result: any; repository_step?: RepositoryStep }>; commit_audit?: SafeAuditEvent[]; contexts?: ContextMap; workspace_commits?: Record<string,unknown> };
export type RepositoryTransactionResult<T> = { data:T; write?:boolean; receipt?:{key:string;digest:string;result:any} };
export type RepositoryTransaction = <T>(context:SecurityContext, command:string, input:unknown,
  options:{key?:string;expected_generation?:string;expected_policy?:string;dry_run?:boolean;replay_authorize?:(engine:Engine,registry:Registry,data:unknown)=>void|Promise<void>},
  work:(engine:Engine, registry:Registry)=>Promise<RepositoryTransactionResult<T>>) => Promise<T>;
export async function startLocalBroker(stateDirectory: string, port = 8787, controls: { repository?: { scope:ProfileServiceScope; build?: (command:string,input:unknown,context:SecurityContext,options:{key?:string;expected_generation?:string;expected_policy?:string;dry_run?:boolean})=>Promise<any> }; runner?:(engine:Engine,input:unknown,context:SecurityContext)=>Promise<any>; refreshAuthority?:()=>void; git?:GitNodeConfig; model_version?: typeof MODEL|typeof CONTENT_MODEL|typeof BLOCK_MODEL; issuer?: AuthorityIssuer; artifacts?: ArtifactRegistryStore; workspace?:WorkspaceBrokerControls; afterStage?: () => Promise<void>; audit?: (event: SafeAuditEvent) => Promise<void>; max_pending?: number; faultForTest?: () => 'after-stage' | 'after-commit' | undefined } = {}): Promise<{ server: Server; url: string; repositoryTransaction:RepositoryTransaction; close: () => Promise<void> }> {
  const issuer = controls.issuer ?? new FixtureIssuer();
  if (controls.artifacts && controls.artifacts.projectId !== issuer.projectId) fail('STORE_BINDING_MISMATCH', 4, 'Host artifact storage belongs to another project.');
  const artifactBinding = controls.artifacts?.binding();
  const releaseLease = await bindNodeState(stateDirectory, issuer.projectId, controls.model_version ?? MODEL);
  let git:GitNodeAdapter|undefined;
  const configuredRepositories=controls.git?.repositories.length??0;
  try{if(controls.git){if(controls.artifacts)fail('UNSUPPORTED_SOURCE_BACKEND',8,'Git adoption requires local artifact storage.');git=new GitNodeAdapter(controls.git,issuer.projectId,stateDirectory);await git.initialize();await git.pendingMarker();}}catch(e){await releaseLease();throw e;}
  try { await noLinks(path.join(stateDirectory, 'artifacts')); await mkdir(path.join(stateDirectory, 'artifacts'), { recursive: true }); }
  catch (error) { await releaseLease(); throw error; }
  const registryFile = path.join(stateDirectory, 'registry.json');
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const auditFile = path.join(stateDirectory, 'audit.jsonl');
  const audit = controls.audit ?? (async (event: SafeAuditEvent) => {
    let bytes = 0; try { bytes = (await stat(auditFile)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (bytes > 16 * 1024 * 1024) fail('AUDIT_UNAVAILABLE', 9, 'The local audit byte limit has been reached.');
    await appendFile(auditFile, JSON.stringify(event) + '\n',controls.workspace?{mode:0o600}:undefined);
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const interrupted=new AbortController();response.once('close',()=>{if(!response.writableEnded)interrupted.abort();});
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health' && request.method === 'GET') { response.end(JSON.stringify({ local: true, runtime: 'node-development-harness', cloudflare_agents_exercised: false })); return; }
    if (request.url !== '/v1/operation' || request.method !== 'POST' || request.headers.origin) { response.statusCode = 404; response.end('{}'); return; }
    let context: SecurityContext | null = null, body: any;
    try {
      controls.refreshAuthority?.();context = issuer.resolve(String(request.headers['x-strata-session'] ?? ''), request.headers['x-strata-project'] ? String(request.headers['x-strata-project']) : issuer.projectId);
      const expectedStore = request.headers['x-strata-artifact-adapter'];
      const actualStore = artifactBinding ? (artifactBinding.mode === 'strict-mock' ? 'cloudflare-artifacts-strict-mock' : 'cloudflare-artifacts-remote') : 'local-persistent-fake';
      if (expectedStore !== undefined && expectedStore !== actualStore) fail('COST_APPROVAL_REQUIRED', 7, 'Broker artifact storage differs from the client configuration; no store access was dispatched.');
      if (pending >= (controls.max_pending ?? 64)) fail('QUEUE_FULL', 9, 'The bounded local operation queue is full.');
      let text = ''; let bytes = 0;
      for await (const part of request) { bytes += Buffer.byteLength(part); if (bytes > MAX_REQUEST_BYTES) fail('INVALID_ARGUMENT', 2, 'Request exceeds the local size limit.'); text += part; }
      body = validateEnvelope(text);
      if(body.command==='drift.revalidate') {
        body.input=normalizeRevalidationRequest(body.input);
        if(!body.options?.dry_run&&!body.options?.idempotency_key)fail('IDEMPOTENCY_REQUIRED',2,'Live revalidation requires the original request key.');
        if(controls.workspace)fail('REVALIDATION_UNSUPPORTED',8,'R1-C uses isolated local Node state; workspace activation remains separate.');
      }
      if(body.command===BUILD_RECOVERY_OPERATION)fail('UNSUPPORTED_CAPABILITY',8,'Build recovery is a private stopped-host seam.');
      issuer.authorize(context, body.command, body.input);
      if(PROFILE_OPERATIONS.includes(body.command)&&!controls.repository || BUILD_OPERATIONS.includes(body.command)&&!controls.repository?.build)
        fail('UNSUPPORTED_CAPABILITY',8,'This broker has no configured repository service for that operation.');
      if (pending >= (controls.max_pending ?? 64)) fail('QUEUE_FULL', 9, 'The bounded local operation queue is full.');
      pending++;
    } catch (error) {
      const e = error instanceof StrataError ? error : new StrataError('INVALID_ARGUMENT', 2, 'Expected one bounded JSON operation.');
      try { if(!(body?.command==='drift.revalidate'&&body.options?.dry_run))await audit(auditEvent(context, body?.command ?? 'invalid', crypto.randomUUID(), 'denied', e.code)); } catch {}
      response.end(JSON.stringify({ ok: false, error: { code: e.code, exit: e.exit, message: e.message } })); return;
    }
    try {
      if(BUILD_OPERATIONS.includes(body.command) && controls.repository?.build) {
        const result=await controls.repository.build(body.command,body.input,context!,{key:body.options?.idempotency_key,dry_run:body.options?.dry_run,
          expected_generation:request.headers['x-strata-expected-generation']?String(request.headers['x-strata-expected-generation']):undefined,
          expected_policy:request.headers['x-strata-expected-policy']?String(request.headers['x-strata-expected-policy']):undefined});
        response.end(JSON.stringify(result));
      } else response.end(JSON.stringify(await enqueue(context!,body,request.headers,interrupted.signal)));
    } catch(error) {
      const e=error instanceof StrataError?error:new StrataError('STORE_UNAVAILABLE',9,'Inspect the original Build request before retrying.');
      response.end(JSON.stringify({ok:false,error:{code:e.code,exit:e.exit,message:e.message,details:e.details}}));
    } finally { pending--; }
  }
  function enqueue(resolved:SecurityContext,body:any,headers:IncomingMessage['headers'],signal:AbortSignal,
    work?: (engine:Engine,registry:Registry)=>Promise<RepositoryTransactionResult<any>>,
    replayAuthorize?:(engine:Engine,registry:Registry,data:unknown)=>void|Promise<void>) {
    const principal = resolved.principal_id;
    const task = queue.then(async () => {
      const operationId=digest({command:body.command,input:body.input,principal,...(controls.workspace?{key:body.options?.idempotency_key??null}:{})});let durable=false,workspaceOperation:WorkspaceBrokerOperation|undefined,revalidation:RevalidationPublication|undefined;
      try {
        controls.refreshAuthority?.();issuer.authorize(resolved, body.command, body.input);
        const dry = body.options?.dry_run === true; const requestedFault = body.options?.fault;
        if (requestedFault && (resolved.trust_mode==='host_authenticated'||principal !== 'bootstrap')) fail('OWNER_FORBIDDEN', 4, 'Fault injection belongs to the bootstrap fixture.');
        const fault = controls.faultForTest?.() ?? requestedFault;
        let registry: Registry;
        try { registry = JSON.parse(await readFile(registryFile, 'utf8')); } catch (e) { if (controls.workspace)fail('WRITER_IMPORT_REQUIRED',9,'The established writer index cannot be loaded.');if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; registry = { entries: {}, heads: {}, requests: {} }; }
        if(controls.workspace)workspaceOperation=await controls.workspace.begin(resolved,body.command,body.input,body.options?.idempotency_key,operationId,registry,signal,dry);
        const requestDigest = digest({ command: body.command, input: body.input, principal });
        if(!(body.command==='drift.revalidate'&&dry))await audit(auditEvent(resolved, body.command, requestDigest.slice(0, 24), 'allowed'));
        const key = (work || MUTATIONS.has(body.command)) && body.options?.idempotency_key ? `${resolved.tenant_id}:${resolved.project_id}:${principal}:${body.options.idempotency_key}` : null;
        if (key && !dry && registry.requests[key]) {
          const step=registry.requests[key].repository_step;
          if(work&&step?.kind==='private' ? step.command!==body.command||step.input_sha256!==digest(body.input) : registry.requests[key].digest!==requestDigest)
            fail('IDEMPOTENCY_CONFLICT', 5, 'Idempotency key binds different input.');
          // Reload durable records and reauthorize every cached mutation before reuse.
        }
        let records: Records = {}, assetBytes: Map<string, Uint8Array>;
        if(workspaceOperation)({records,assetBytes}=await workspaceOperation.load(registry));
        else if (controls.artifacts) ({ records, assetBytes } = await controls.artifacts.load(registry));
        else {
          if (registry.storage || registry.asset_locators || Object.values(registry.entries).some(e => e.locator)) fail('STORE_BINDING_REQUIRED', 4, 'Remote registry requires the exact trusted host store; local fallback is forbidden.');
          for (const [ref, entry] of Object.entries(registry.entries)) {
            const text = await readFile(path.join(stateDirectory, 'artifacts', entry.hash + '.json'), 'utf8');
            if (bytesDigest(text) !== entry.hash) fail('STORE_UNAVAILABLE', 9, 'An indexed artifact is corrupt.');
            records[ref] = { type: entry.type, published: entry.published, data: JSON.parse(text) };
          }
          assetBytes = await loadAssetBytes(stateDirectory, records);
        }
        const engine = new Engine(records, registry.heads, {projectId:issuer.projectId,assetBytes,modelVersion:controls.model_version ?? MODEL, checkerBackend:controls.repository?'node':undefined});
        if((body.command==='inspect'||body.command==='review.state')&&Object.hasOwn(REVALIDATION_SCHEMAS,records[body.input.ref]?.type))verifyRetainedRevalidation(records,issuer.projectId);
        const adoptedPublish=body.command==='layer.publish'&&records[body.input.ref]?.type==='layer'&&adoptionRequired(records,records[body.input.ref].data);
        if(!git&&(body.command.startsWith('adoption.')||adoptedPublish))fail('UNSUPPORTED_SOURCE_BACKEND',8,'Adoption operations and retries require the configured trusted Node source host.');
        if (key && !dry && registry.requests[key]) {
          issuer.authorize(resolved, body.command, body.input, engine);
          const cached=registry.requests[key],step=cached.repository_step;
          if(step){
            assertRepositoryStep(step,resolved,engine,issuer,controls.repository?.scope,work?body.command:undefined);
            if(work&&step.kind==='private'){
              await replayAuthorize?.(engine,registry,step.callback_result);
              await workspaceOperation?.refresh();issuer.authorize(resolved,body.command,body.input,engine);
              assertRepositoryStep(step,resolved,engine,issuer,controls.repository?.scope,body.command);
              return {...cached.result,data:structuredClone(step.callback_result),reused:true};
            }
          }
          // Legacy private receipts have no independent callback-result pin.
          // Their trusted consumer retains its existing cache/revalidation path.
          if(work) {
            if(!step)issuer.assertRepository(resolved,PROFILE_OPERATIONS.includes(body.command)?body.command:'build.inspect',controls.repository!.scope.repository_id,[]);
          } else {
          if(body.command==='drift.revalidate'){
            const replay=await startRevalidation(engine,body.input,resolved,issuer,git,counterRevalidator,()=>controls.refreshAuthority?.(),signal,false,registry.requests[key].result.data);
            controls.refreshAuthority?.();replay.publishGuard();
            return {...registry.requests[key].result,data:replay.data,reused:true};
          }
          if(PROFILE_OPERATIONS.includes(body.command) && controls.repository) {
            const profiles=namespaceProfileService(engine,controls.repository.scope,resolved,issuer);
            profiles.assertAuthority(body.command,body.input); profiles.assertVisibleRecord(registry.requests[key].result.data.ref);
          }
          await git?.cached(body.command,body.input,registry.requests[key].result.data,engine,resolved,issuer);git?.bridgeAuthorityGate(engine,body.command,body.input,resolved,issuer,registry.requests[key].result.data);return { ...registry.requests[key].result, reused: true };
          }
        }
        if(headers['x-strata-expected-generation']&&headers['x-strata-expected-generation']!==digest(controls.repository?buildRepositoryView(engine,controls.repository.scope,resolved):visibleRecords(engine,principal)))fail('STALE_GENERATION',5,'The saved principal view changed before dispatch.');
        if(headers['x-strata-expected-policy']&&headers['x-strata-expected-policy']!==resolved.policy_version)fail('STALE_POLICY',5,'The assigned policy changed before dispatch.');
        if(body.command==='operation.inspect'&&!work) {
          issuer.authorize(resolved,body.command,body.input,engine);
          if(Object.keys(body.input).some(k=>k!=='key')||typeof body.input.key!=='string'||!body.input.key||body.input.key.length>128)fail('INVALID_ARGUMENT',2,'An exact request key is required.');
          const receipt=registry.requests[`${resolved.tenant_id}:${resolved.project_id}:${principal}:${body.input.key}`];
          if(receipt)assertRepositoryReceipt(receipt,resolved,engine,issuer,controls.repository?.scope);
          if(receipt&&!controls.repository&&(receipt.result.data?.build_id||buildRecordType(engine.records[receipt.result.data?.ref]?.type)))
            fail('UNSUPPORTED_CAPABILITY',8,'Original supporting outcome requires the configured repository backend.');
          if(receipt&&controls.repository) {
            const value=receipt.result.data, scope=controls.repository.scope;
            if(value?.build_id) {
              issuer.authorize(resolved,'build.inspect',{build_id:value.build_id},engine);
              issuer.assertRepository(resolved,'build.inspect',scope.repository_id,[]);
              if(value.project_id!==scope.project_id||value.repository_id!==scope.repository_id)fail('BUILD_UNAVAILABLE',4,'Original request is outside this repository.');
              verifyBuildAttempts(engine.records,scope.project_id);
            } else if(value?.ref&&buildRecordType(engine.records[value.ref]?.type)) {
              const profiles=namespaceProfileService(engine,scope,resolved,issuer), r=engine.records[value.ref];
              profiles.assertAuthority(r.type==='build-profile'?'profile.inspect':'repository.compatibility',r.type==='build-profile'?{ref:value.ref}:{});
              profiles.assertVisibleRecord(value.ref);
              if(value.sha256&&value.sha256!==digest(r.data))fail('BUILD_SOURCE_PIN_MISMATCH',6,'Original receipt differs from immutable supporting bytes.');
            }
          }
          if(receipt?.result.data.completion_ref)verifyRetainedRevalidation(records,issuer.projectId);
          const data=receipt?{key:body.input.key,state:'committed',result:receipt.result.data.completion_ref?{...receipt.result,data:{...receipt.result.data,live_source_checked:false}}:receipt.result}:controls.workspace?await controls.workspace.status(resolved,body.input.key):{key:body.input.key,state:'not_found',result:null};
          return {ok:true,data,created:[],operation_id:requestDigest.slice(0,24)};
        }
        if (PROFILE_OPERATIONS.includes(body.command) && controls.repository) {
          const profiles=namespaceProfileService(engine,controls.repository.scope,resolved,issuer);
          profiles.assertAuthority(body.command,body.input);
        }
        const contexts = registry.contexts ?? {}; const before = new Set(Object.keys(records));
        const sourceOperation=body.command.startsWith('git.')||body.command.startsWith('source.')||body.command.startsWith('drift.')||body.command.startsWith('adoption.')||body.command==='layer.publish';
        const privateResult = work ? await work(engine, registry) : undefined;
        const data = privateResult ? privateResult.data : PROFILE_OPERATIONS.includes(body.command) && controls.repository ? namespaceProfileService(engine, controls.repository.scope, resolved, issuer).execute(body.command,body.input) : body.command==='drift.revalidate' ? (revalidation=await startRevalidation(engine,body.input,resolved,issuer,git,counterRevalidator,()=>controls.refreshAuthority?.(),signal,dry)).data : body.command==='evidence.run' ? await (async()=>{executeAuthorized(engine,'evidence.run',body.input,resolved,issuer,dry,contexts);if(!controls.runner)fail('RUNNER_NOT_CONFIGURED',8,'No finite measured host runner is configured.');if(dry)return {execution_ready:false};return controls.runner(engine,body.input,resolved);})() : sourceOperation && git ? await git.execute(engine,body.command,body.input,resolved,issuer,dry,operationId) : executeAuthorized(engine, body.command, body.input, resolved, issuer, dry, contexts);
        if(!work&&body.command==='studio.snapshot'&&controls.repository) {
          data.records=buildRepositoryView(engine,controls.repository.scope,resolved);data.generation=digest(data.records);
        }
        const result = { ok: true, data: data === undefined ? null : data, created: dry ? [] : Object.keys(engine.records).filter(ref => !before.has(ref)), operation_id: controls.workspace?operationId:requestDigest.slice(0, 24), dry_run: dry };
        if (body.command === 'status' && artifactBinding) { data.artifact_adapter = artifactBinding.mode === 'strict-mock' ? 'cloudflare-artifacts-strict-mock' : 'cloudflare-artifacts-remote'; data.artifact_storage = artifactBinding; }
        if(!work&&(body.command==='status'||body.command==='capabilities')){
          const native=describeNativeSupport(engine.modelVersion(),resolved,git?{repositories:configuredRepositories,enabled_checkers:[...new Set((git.config.enabledCheckers??[]).filter(id=>id===APPLICATION_CHECKER))],revalidation_configured:issuer instanceof HostIssuer&&issuer.revalidationConfigured(resolved)}:undefined);
          data.native_support=native;
          if(body.command==='status')Object.assign(data.capabilities,nativeCapabilityFlags(native));
          else data.operations=data.operations.map((row:any)=>({...row,...nativeOperationSupport(native,row.operation)}));
          if(body.command==='capabilities'&&controls.repository)data.operations=data.operations.map((row:any)=>{
            const profile=PROFILE_OPERATIONS.includes(row.operation),build=BUILD_OPERATIONS.includes(row.operation);
            if(!profile&&!build)return row;
            const configured=profile||!!controls.repository!.build;let allowed=configured;
            try {
              issuer.authorize(resolved,row.operation,{},engine);issuer.assertRepository(resolved,row.operation,controls.repository!.scope.repository_id,[]);
              if(['build.prepare','build.start'].includes(row.operation))for(const op of ['materialize','realization.register','evidence.run','inspect','build.inspect','build.outputs'])
                issuer.authorize(resolved,op,['materialize','evidence.run'].includes(op)?{profile:'collection-host/1'}:{},engine);
            } catch {allowed=false;}
            return {...row,configured,supported:configured&&row.supported!==false,allowed};
          });
        }
        if (dry || (work ? !privateResult?.write : !MUTATIONS.has(body.command))) {
          if(work&&!dry)await workspaceOperation?.failed(false,new StrataError('NO_REPOSITORY_EFFECT',9,'No new repository effect was dispatched.'));
          return result;
        }
        if(work||controls.repository) {
        validateRecords(engine.records,issuer.projectId,controls.model_version ?? MODEL);
        for(const [ref,old] of Object.entries(registry.entries)) {
          const r=engine.records[ref];
          if(!r || old.hash!==bytesDigest(canonical(r.data)) || old.type!==r.type || old.published&&!r.published)
            fail('IMMUTABLE_REFERENCE',5,'Repository transaction cannot rewrite or drop admitted history.');
        }
        if(Object.keys(engine.records).length>20000 || Object.keys(registry.requests).length>=20000)fail('STORE_UNAVAILABLE',9,'Repository history capacity is full.');
        }
        workspaceOperation?.verifyPreparedRecords(engine.records);
        let entries: Registry['entries'] = {}, storage = registry.storage, asset_locators = registry.asset_locators;
        if (controls.artifacts) {
          const staged = await controls.artifacts.stage(engine.records, assetBytes, registry);
          ({ entries, storage, asset_locators } = staged);
          if (staged.receipt) {
            // Survives a failed index commit and identifies unpublished immutable stages.
            const journal = path.join(stateDirectory, 'artifact-stages.jsonl'); await noLinks(journal);
            let size = 0; try { size = (await stat(journal)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            const receipt = canonical({ ...staged.receipt, operation_id: result.operation_id });
            if (size + Buffer.byteLength(receipt) > 16 * 1024 * 1024) fail('STORE_UNAVAILABLE', 9, 'Artifact staging journal is full.', staged.receipt);
            await appendFile(journal, receipt + '\n',controls.workspace?{mode:0o600}:undefined);
          }
        } else for (const [ref, record] of Object.entries(engine.records)) {
          const text = canonical(record.data); const hash = bytesDigest(text); const destination = path.join(stateDirectory, 'artifacts', hash + '.json');
          try { await writeFile(destination, text, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (await readFile(destination, 'utf8') !== text) fail('ARTIFACT_COLLISION', 9, 'Existing artifact bytes differ.'); }
          entries[ref] = { hash, type: record.type, published: record.published };
          if((revalidation||work)&&!before.has(ref)){const handle=await open(destination,'r+');try{await handle.sync();}finally{await handle.close();}}
        }
        if (fault === 'after-stage') fail('INJECTED_STAGE_FAILURE', 9, 'Fixture failure after staging, before index publication.');
        await controls.afterStage?.();controls.refreshAuthority?.(); issuer.authorize(resolved, body.command, body.input, engine);
        if(sourceOperation)await git?.recheck(engine,body.command,body.input,resolved,issuer,result.data);
        controls.artifacts?.binding(); // Recheck the trusted run grant/budget immediately before local publication.
        const commitEvent = auditEvent(resolved, body.command, requestDigest.slice(0, 24), 'committed'); commitEvent.references = commitReferences(body.command, body.input, result);
        if ((registry.commit_audit?.length ?? 0) >= 20000) fail('AUDIT_UNAVAILABLE', 9, 'The bounded local commit audit ledger is full.');
        const next: Registry = { entries, ...(storage ? { storage, asset_locators } : {}), heads: engine.ownerHeads, contexts, requests: registry.requests, commit_audit: [...(registry.commit_audit ?? []), commitEvent] };
        const step:RepositoryStep|undefined=work?{format:'strata-repository-step/1',kind:'private',project_id:resolved.project_id,
          repository_id:controls.repository!.scope.repository_id,principal_id:principal,command:body.command,input_sha256:digest(body.input),
          callback_result:result.data,created_refs:result.created}:undefined;
        if (key) next.requests[key] = { digest: requestDigest, result,...(step?{repository_step:step}:{}) };
        if(privateResult?.receipt) {
          const originalStep=registry.requests[privateResult.receipt.key]?.repository_step;
          next.requests[privateResult.receipt.key]={digest:privateResult.receipt.digest,result:privateResult.receipt.result,
            ...(step?{repository_step:originalStep??(privateResult.receipt.key===key?step:{...step,kind:'original',callback_result:null})}:{})};
        }
        const temp = path.join(stateDirectory, 'registry-' + requestDigest.slice(0, 24) + '.tmp');
        if(!workspaceOperation) {
          if(revalidation||work){const handle=await open(temp,'w');try{await handle.writeFile(canonical(next));await handle.sync();}finally{await handle.close();}}
          else await writeFile(temp, canonical(next));
        }
        if(revalidation){
          // Temp and all immutable artifacts are prepared before the final awaited capture.
          await revalidation.lateCheck();
          controls.refreshAuthority?.();revalidation.publishGuard();
          // No await between the final live/proof guard and registry publication.
          renameSync(temp,registryFile);durable=true;
          try{if(process.platform!=='win32'){const fd=openSync(stateDirectory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}}
          catch{return {ok:false,error:{code:'REVALIDATION_DURABILITY_UNCERTAIN',exit:9,message:'The registry was renamed; inspect the original request key before retrying.',details:{publication_state:'renamed-durability-uncertain'}}};}
          if(fault==='after-commit')fail('INJECTED_RESPONSE_LOSS',9,'Response lost after atomic completion publication.');
          return result;
        }
        if(workspaceOperation){
          next.workspace_commits={...(registry.workspace_commits??{}),[operationId]:await workspaceOperation.provenance(registry,next,result)};
          const handle=await open(temp,'wx',0o600);try{await handle.writeFile(canonical(next));await handle.sync();}finally{await handle.close();}
          await controls.workspace?.beforeRenameForTest?.();
          await workspaceOperation.refresh();issuer.authorize(resolved,body.command,body.input,engine);
          workspaceOperation.assertSync('final-index-publication');
          // No await between the last guard and rename plus directory fsync.
          renameSync(temp,registryFile);durable=true;
          try{if(controls.workspace?.directorySyncForTest)controls.workspace.directorySyncForTest();else if(process.platform!=='win32'){const fd=openSync(stateDirectory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}}
          catch{await workspaceOperation.failed(true,new StrataError('WORKSPACE_DURABILITY_UNCERTAIN',9,'The index was renamed but directory durability needs operator reconciliation.'));return {ok:false,error:{code:'WORKSPACE_DURABILITY_UNCERTAIN',exit:9,message:'The operation receipt is retained. Check its outcome; further writes require reconciliation.',details:{operation_id:operationId,publication_state:'renamed-durability-uncertain'}}};}
          try{await workspaceOperation.committed(next,result);}catch{return {...result,persistence_warning:'The committed index receipt is retained; the recovery journal needs reconciliation.'};}
          return result;
        }
        // G2's in-process fixture authority and local index commit share one
        // synchronous boundary. No awaited native work follows its final guard.
        if(git?.bridgeAuthorityGate(engine,body.command,body.input,resolved,issuer,result.data))renameSync(temp,registryFile);
        else await rename(temp, registryFile);
        durable=true;await git?.committed(operationId,engine);
        if (fault === 'after-commit') fail('INJECTED_RESPONSE_LOSS', 9, 'Fixture response loss after index publication.');
        return result;
      } catch (e) {
        try{await workspaceOperation?.failed(durable,e);}catch{}
        let caught=e;if(!durable){try{await git?.abort(operationId);}catch(recovery){caught=recovery;}}
        const error = caught instanceof StrataError ? caught : new StrataError('STORE_UNAVAILABLE', 9, 'Local broker execution or audit persistence failed.');
        try { if(!(body.command==='drift.revalidate'&&body.options?.dry_run))await audit(auditEvent(resolved, body.command, digest({ command: body.command, input: body.input, principal }).slice(0, 24), 'denied', error.code)); } catch {}
        return { ok: false, error: { code: error.code, exit: error.exit, message: error.message, details: error.details } };
      }finally{workspaceOperation?.close();}
    });
    queue = task.catch(() => {}); return task;
  }
  const active = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task = handleRequest(request, response); active.add(task);
    void task.then(() => active.delete(task), () => { active.delete(task); response.destroy(); });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await releaseLease(); throw error; }
  const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port;
  let closing: Promise<void> | undefined;
  const repositoryTransaction:RepositoryTransaction=async(context,command,input,options,work)=>{
    if(closing || !controls.repository)fail('STORE_UNAVAILABLE',9,'Private repository transactions require the configured sole broker.');
    controls.refreshAuthority?.(); issuer.authorize(context,command,input);
    if(pending>=(controls.max_pending??64))fail('QUEUE_FULL',9,'The bounded local operation queue is full.');
    pending++;
    try {
      const key=options.key??digest({domain:'strata-private-repository-step/1',command,input,actor:context.principal_id});
      const result=await enqueue(context,{command,input,options:{idempotency_key:key,dry_run:options.dry_run}},
        {'x-strata-expected-generation':options.expected_generation,'x-strata-expected-policy':options.expected_policy},AbortSignal.timeout(60_000),work,options.replay_authorize);
      if(!result.ok)fail(result.error.code,result.error.exit,result.error.message,result.error.details);
      return result.data;
    } finally {pending--;}
  };
  return { server, repositoryTransaction, url: `http://127.0.0.1:${actualPort}`, close: () => closing ??= (async () => {
    await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
    await Promise.allSettled([...active]); await queue; await releaseLease();
  })() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = process.env.STRATA_MODEL_VERSION ?? MODEL;
  if(model!==MODEL && model!==CONTENT_MODEL && model!==BLOCK_MODEL) fail('UNSUPPORTED_MODEL_VERSION',8,'Select an explicitly supported Node model.');
  const broker = await startLocalBroker(path.resolve(process.env.STRATA_STATE_DIR ?? '.strata/node-state'),8787,{model_version:model});
  process.stderr.write(`Strata local Node development harness at ${broker.url}; Cloudflare Agent runtime is not exercised.\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await broker.close(); process.exitCode = 0; });
}
