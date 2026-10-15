import { workflow, WORKFLOW_READS } from './workflow.js';
import { validateCommandInput } from './commands/contract.js';
import { Engine, snapshotFromRelease } from './core.js';
import { migrationPreview } from './content.js';
import { CONTENT_MODEL, BLOCK_MODEL, isContentModel, fail, digest, canonical, item, type Composition, type Layer } from './model.js';
import { FixtureIssuer, type AuthorityIssuer, type SecurityContext } from './security.js';
import { personalContext, restoreLayer, type ContextMap } from './recovery.js';
import { executeDrift } from './reconciliation.js';
import { completionProjection,reconciliationCompletionSchema,REVALIDATION_SCHEMAS } from './revalidation.js';
import { BUILD_MUTATIONS } from './build-operations.js';
import { PROFILE_MUTATIONS } from './build-records.js';

export function executeAuthorized(engine: Engine, command: string, input: any, context: SecurityContext, issuer: AuthorityIssuer, dryRun = false, contexts: ContextMap = {}) {
  validateCommandInput(command,input);
  issuer.authorize(context, command, input, engine);
  if(command==='drift.revalidate')fail('REVALIDATION_PROOF_REQUIRED',8,'Revalidation requires the trusted asynchronous Node transaction; JSON dispatch cannot publish execution.');
  if(WORKFLOW_READS.includes(command))return workflow(engine,command,input,context.principal_id,context);
  const before=structuredClone(engine.records), heads=structuredClone(engine.ownerHeads);
  if(context.trust_mode==='host_authenticated'&&engine.modelVersion()===BLOCK_MODEL)engine.authentication={receipt:{format:'strata-host-auth/1',project_id:context.project_id,model_version:BLOCK_MODEL,principal_id:context.principal_id,principal_kind:context.principal_kind,account_id:context.account_id,credential_epoch:context.credential_epoch,action:command,input_sha256:digest(input),request_sha256:digest({command,input,principal:context.principal_id,policy:context.policy_version}),policy_generation:context.policy_version,grant_id:context.grant_id,expires_at:context.expires_at,trust:'host-authenticated'},assertLive:()=>issuer.assertLive(context)};
  let data:any;
  try { data = command.startsWith('drift.')?executeDrift(engine,command,input,context,issuer):execute(engine, command, input, context.principal_id, dryRun, contexts); }
  catch(error) {engine.records=before;engine.ownerHeads=heads;throw error;}
  if (command === 'status') data.security_context = structuredClone(context);
  if (command.startsWith('context.')) data.project_id = context.project_id;
  if (command === 'validate') data.evidence_producer = { principal_id: context.principal_id, trust_mode: context.trust_mode, attestation: context.trust_mode==='host_authenticated'?'host-measured-with-authenticated-review':'fixture-import-only' };
  return data;
}

export const MUTATIONS = new Set([...PROFILE_MUTATIONS, ...BUILD_MUTATIONS, 'build.reconcile', 'drift.revalidate','adoption.prepare','adoption.review','mediation.install','evidence.run','criterion.review','source.capture','source.bind','drift.check','drift.propose','drift.review','git.plan','git.stage','git.check','git.evidence','git.review','git.apply','git.finalize','git.transaction.recover','mediation.prepare', 'mediation.respond', 'reports.dispose', 'content.review', 'init', 'layer.create', 'layer.revise', 'layer.publish', 'layer.restore', 'context.use', 'compose', 'resolve', 'approve', 'realization.register', 'validate', 'release', 'conflicts.report']);
export function execute(engine: Engine, command: string, input: any, principal: string, dryRun = false, contexts: ContextMap = {}): any {
  if(command.startsWith('git.')||command.startsWith('source.')||command.startsWith('drift.')||command.startsWith('adoption.'))fail('UNSUPPORTED_SOURCE_BACKEND',8,'Source/Git/adoption operations require the explicitly configured Node host backend.');
  switch (command) {
    case 'init': {const initialized=engine.init(input.record,principal,!!engine.authentication);if(isContentModel(engine.modelVersion()))engine.mediation?.install(initialized.ref);return initialized;}
    case 'evidence.run': return {execution_ready:false};
    case 'criterion.review':return engine.criterionReview(input,principal);
    case 'mediation.install':if(!engine.authentication)fail('AUTHENTICATION_REQUIRED',4,'Explicit installation needs a host actor.');engine.mediation!.install(input.baseline);return {installed:true};
    case 'mediation.prepare': engine.mediationGate();return engine.mediation!.prepare(input);
    case 'mediation.respond': engine.mediationGate();return engine.mediation!.respond(input);
    case 'reports.dispose': engine.mediationGate();return engine.mediation!.disposition(input);
    case 'context.show': case 'context.use': return personalContext(engine, contexts, command, input, principal);
    case 'layer.restore': return restoreLayer(engine, input, principal);
    case 'layer.create': return engine.layer(input.record, principal);
    case 'layer.revise': return engine.layer(input.record, principal, input.previous);
    case 'layer.publish': return engine.publish(input.ref, principal, input.review, input.authoring_review, input.adoption_review);
    case 'content.review': return engine.contentReview(input.record,principal);
    case 'migration.preview': return migrationPreview(input.source,engine.read(input.source,'release'),input.source_digest);
    case 'compose': return engine.compose(input.record);
    case 'resolve': return engine.resolution(input.record, principal, dryRun);
    case 'approve': return engine.approve(input.record, principal);
    case 'materialize': return engine.realize(input.target, input.profile);
    case 'realization.register': return engine.registerRealization(input.record);
    case 'validate': return engine.validate(input.target, input.realization, input.evidence);
    case 'release': return engine.release(input.target, input.validation, input.approvals);
    case 'inspect': {
      const record=engine.inspect(input.type,input.ref,principal,input.limit,input.cursor);
      if(!input.ref||!Object.hasOwn(REVALIDATION_SCHEMAS,input.type))return record;
      return {...(input.type==='reconciliation-completion'?completionProjection(input.ref,reconciliationCompletionSchema.parse(record)):{ref:input.ref,type:input.type}),record,record_sha256:digest(record),live_source_checked:false,live_authority_checked:false,execution_checked:false};
    }
    case 'conflicts': {
      const evaluation = engine.target(input.target); const record = engine.records[input.target];
      return { ...evaluation, target_type: record.type, baseline_ref: record.type === 'release' ? input.target : record.data.baseline };
    }
    case 'conflicts.report': {
      if(isContentModel(engine.modelVersion())) {engine.mediationGate();return engine.mediation!.report(input);}
      const composition: Composition = engine.read(input.target, 'composition');
      if (!input.report || typeof input.report.message !== 'string' || !input.report.message.trim() || Object.keys(input.report).some(k => k !== 'message')) fail('INVALID_RECORD', 2, 'Interaction reports accept a message only.');
      const data = { composition: `${composition.id}@${composition.revision}`, candidate: engine.target(input.target).fingerprint, principal, message: input.report.message };
      const ref = 'interaction@' + digest(data).slice(0, 24); engine.store(ref, 'interaction', { ...data, ref }); return { ref, state: 'blocked' };
    }
    case 'status': return { model_version: engine.modelVersion(), capabilities: { 'content/1':engine.modelVersion()===CONTENT_MODEL, 'assets/1':engine.modelVersion()===CONTENT_MODEL && !!engine.options.assetBytes, 'mediation/1':engine.modelVersion()===CONTENT_MODEL && !!engine.mediation?.enabled() }, mediation_generation:engine.modelVersion()===CONTENT_MODEL && engine.mediation?.enabled() ? engine.mediation.generation():null, identity_policy: 'trusted-local-fixture-sessions', artifact_adapter: 'local-persistent-fake', records: Object.values(engine.records).filter(r => r.published || r.data.owner === principal).length, owned_heads: Object.fromEntries(Object.entries(engine.ownerHeads).filter(([, h]) => h.owner === principal)), candidate: input.target ? engine.target(input.target) : null };
    case 'diff': {
      const left = engine.target(input.left).snapshot; const right = engine.target(input.right).snapshot;
      if (left.model_version !== right.model_version) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Diff cannot cross model versions.');
      const changes = [];
      for (const blockId of [...new Set([...Object.keys(left.blocks), ...Object.keys(right.blocks)])].sort()) {
        const a = left.blocks[blockId], b = right.blocks[blockId];
        if (!a || !b) { changes.push({ block: blockId, path: null, before: a ?? null, after: b ?? null }); continue; }
        const paths = ['purpose', 'parent', ...(a.description ? ['description',...Array.from(new Set([...Object.keys(a.asset_refs ?? {}),...Object.keys(b.asset_refs ?? {})])).map(k=>'asset_refs.'+k)] : []), ...['requirements', 'acceptance', 'relationships'].flatMap(c => [...new Set([...Object.keys((a as any)[c]), ...Object.keys((b as any)[c])])].map(k => `${c}.${k}`)), ...['inputs', 'outputs', 'failures'].flatMap(c => [...new Set([...Object.keys((a.contract as any)[c]), ...Object.keys((b.contract as any)[c])])].map(k => `contract.${c}.${k}`))].sort();
        for (const path of paths) { const before = item(a, path), after = item(b, path); if (canonical(before.exists ? before.value : { absent: true }) !== canonical(after.exists ? after.value : { absent: true })) changes.push({ block: blockId, path, before: before.exists ? { kind: 'value', value: before.value } : { kind: 'absent' }, after: after.exists ? { kind: 'value', value: after.value } : { kind: 'absent' } }); }
      }
      return { left: input.left, right: input.right, changes };
    }
    default: fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown broker operation.', { command });
  }
}
