import { WORKFLOW_READS } from './workflow.js';
import { canonical, digest, fail, type Layer } from './model.js';
import type { Engine } from './core.js';
import { Mediation, type MediationConfig } from './mediation.js';
import { recoveryInput, restorationSource } from './recovery.js';
import { PROFILE_OPERATIONS } from './build-records.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from './build-operations.js';

export const LOCAL_PROJECT = 'strata-local-demo';
export const MAX_REQUEST_BYTES = 1024 * 1024;
const READ = [...WORKFLOW_READS, 'status', 'inspect', 'diff', 'conflicts', 'migration.preview', 'context.show', 'context.use'];
const AUTHOR = ['layer.create', 'layer.revise', 'layer.publish', 'layer.restore'];
export type SecurityContext = {
  trust_mode: 'local_fixture'|'host_authenticated'; principal_id: string; principal_kind: 'fixture'|'person'|'agent';
  tenant_id: string; project_id: string; allowed_operations: string[];
  layer_ids: string[] | null; write_block_ids: string[] | null; create_under_block_ids?:string[];
  grant_id: string; delegator_id: string | null; expires_at: string | null;
  policy_version: string; authority_ref: 'pinned-baseline';
  account_id?:string; credential_epoch?:number;
  authentication_id?:string;
};
export type Assignment = {
  principal: string; operations: string[]; layer_ids?: string[] | null; write_block_ids?: string[] | null;
  approvals?: string[]; executor?: string; reviewers?: string[]; expires_at?: string | null;
  create_under_block_ids?:string[]; repositories?: string[]; git_paths?: string[]; git_checkers?: string[];
};
export interface AuthorityIssuer {
  readonly projectId:string;
  resolve(selector:string,project?:string):SecurityContext;
  assertLive(context:SecurityContext):void;
  authorize(context:SecurityContext,command:string,input:any,engine?:Engine):void;
  active(principal:string):boolean;
  permitsApproval(context:SecurityContext,kind:string):boolean;
  bindMediation(engine:Engine,context:SecurityContext):void;
  accessBinding():string;
  time():number;
  narrowSelectionExecutor(principal:string):boolean;
  assertRepository(context:SecurityContext,command:string,repo:string,paths:string[],checker?:string):void;
  assertGitEvidence(context:SecurityContext,results:{method:string;reviewer:string|null}[]):void;
}
const FIXTURES: Record<string, Assignment> = {
  'fixture-backup': { principal: 'backup-operator', operations: ['backup.create', 'backup.verify', 'backup.inspect', 'backup.restore'] },
  'fixture-reader': { principal: 'reader', operations: READ },
  'fixture-a': { principal: 'author-a', operations: [...READ, ...AUTHOR] },
  'fixture-b': { principal: 'author-b', operations: [...READ, ...AUTHOR] },
  'fixture-c': { principal: 'author-c', operations: [...READ, ...AUTHOR] },
  'fixture-preparer': { principal: 'preparer', operations: [...READ, 'compose', 'resolve', 'mediation.prepare', 'materialize', 'realization.register'] },
  'fixture-reviewer': { principal: 'interaction-reviewer', operations: [...READ, 'conflicts.report', 'mediation.respond'] },
  'fixture-runner': { principal: 'fixture-runner', operations: [...READ, 'validate'], executor: 'strata-local-fixture-runner/1', reviewers: ['fixture-reviewer'] },
  'fixture-selector': { principal: 'scope-selector', operations: [...READ, ...AUTHOR, 'approve', 'resolve', 'mediation.respond', 'reports.dispose'], approvals: ['resolution', 'scope'] },
  'fixture-release': { principal: 'release-manager', operations: [...READ, 'approve', 'release'], approvals: ['release'] },
  'fixture-guardian': { principal: 'safety-guardian', operations: [...READ, 'approve'], approvals: ['guardian'] },
  'fixture-bootstrap': { principal: 'bootstrap', operations: [...READ, ...AUTHOR, 'init'] }
};
// A test issuer, not token issuance/authentication. Public selectors remain impersonable
// by a trusted local process. There is no hosted verifier, key, OAuth flow or policy API.
export class FixtureIssuer implements AuthorityIssuer {
  private version = 1;
  private suspended = new Set<string>();
  private readonly assignments: Record<string, Assignment>;
  constructor(private readonly options: { project_id?: string; assignments?: Record<string, Assignment>; now?: () => number; hosted?: boolean; mediation?:MediationConfig | false } = {}) {
    this.assignments = structuredClone({ ...FIXTURES, ...(options.assignments ?? {}) });
  }
  get projectId() { return this.options.project_id ?? LOCAL_PROJECT; }
  accessBindingForFixture() {return digest({assignments:this.assignments,version:this.version,suspended:[...this.suspended].sort()});}
  timeForFixture() {return this.now();}
  accessBinding(){return this.accessBindingForFixture();}
  time(){return this.timeForFixture();}
  narrowSelectionExecutor(principal:string) {return Object.values(this.assignments).some(a=>a.principal===principal && a.operations.includes('mediation.respond') && a.approvals?.length===1 && a.approvals[0]==='resolution' && a.operations.every(op=>['status','inspect','conflicts','approve','resolve','mediation.respond'].includes(op)));}
  permitsApproval(context:SecurityContext,kind:string) {this.assertLive(context);return !!this.assignments[context.grant_id]?.approvals?.includes(kind);}
  bindMediation(engine:Engine,context:SecurityContext) {if(this.options.mediation!==false)engine.mediation=new Mediation(engine,this,context,structuredClone(this.options.mediation ?? {generation:1,policies:[],grants:[]}));}
  private now() { return (this.options.now ?? Date.now)(); }
  resolve(selector: string, project = this.projectId): SecurityContext {
    if (this.options.hosted) fail('HOSTED_IDENTITY_UNAVAILABLE', 4, 'Hosted identity verification is not implemented; local fixtures cannot authenticate hosted requests.');
    if (project !== this.projectId) fail('PROJECT_FORBIDDEN', 4, 'This broker is bound to one local fixture project.');
    const assignment = this.assignments[selector];
    if (!assignment || !Object.hasOwn(this.assignments, selector)) fail('AUTHENTICATION_REQUIRED', 4, 'Supply a configured nonsecret local fixture selector.');
    if (!this.active(assignment.principal)) fail('ACCESS_REVOKED', 4, 'The local fixture assignment is expired or suspended.');
    return {
      trust_mode: 'local_fixture', principal_id: assignment.principal, principal_kind: 'fixture',
      tenant_id: 'local-fixture', project_id: this.projectId, allowed_operations: [...assignment.operations],
      layer_ids: assignment.layer_ids === undefined ? null : structuredClone(assignment.layer_ids),
      write_block_ids: assignment.write_block_ids === undefined ? null : structuredClone(assignment.write_block_ids),
      create_under_block_ids:structuredClone(assignment.create_under_block_ids??[]),
      grant_id: selector, delegator_id: null, expires_at: assignment.expires_at ?? null,
      policy_version: 'fixture-policy/' + this.version, authority_ref: 'pinned-baseline'
    };
  }
  active(principal: string) {
    return !this.suspended.has(principal) && Object.values(this.assignments).some(a => a.principal === principal && (!a.expires_at || Date.parse(a.expires_at) > this.now()));
  }
  assertRepository(context: SecurityContext, command: string, repoId: string, paths: string[], checker?: string) {
    this.assertLive(context);
    const grant = this.assignments[context.grant_id];
    if (!context.allowed_operations.includes(command) || !grant.repositories?.includes(repoId)) fail('REPOSITORY_FORBIDDEN', 4, 'Operation requires an explicitly assigned repository grant.');
    if (paths.some(p => !grant.git_paths?.includes(p))) fail('PATCH_SCOPE', 4, 'Paths exceed the assigned repository scope.');
    if (checker && !grant.git_checkers?.includes(checker)) fail('EVIDENCE_PRODUCER_FORBIDDEN', 4, 'Checker is not assigned to this repository operation.');
  }
  assertGitEvidence(context: SecurityContext, results: { method: string; reviewer: string | null }[]) {
    this.assertLive(context); const grant = this.assignments[context.grant_id];
    if (!grant.executor || results.some(r => r.method === 'review' && (!r.reviewer || !grant.reviewers?.includes(r.reviewer)))) fail('EVIDENCE_PRODUCER_FORBIDDEN', 4, 'Application evidence requires an assigned producer and reviewer labels.');
  }
  // Trusted in-process test control only; deliberately absent from HTTP/CLI.
  suspendForTest(principal: string) { this.suspended.add(principal); this.version++; }
  assertLive(context: SecurityContext) {
    const fresh = this.resolve(context.grant_id, context.project_id);
    if (fresh.policy_version !== context.policy_version) fail('STALE_POLICY', 5, 'The fixture policy changed while this operation was pending.');
    if (canonical(fresh) !== canonical(context)) fail('OWNER_FORBIDDEN', 4, 'Security context must come from the configured server-side fixture issuer.');
  }
  authorize(context: SecurityContext, command: string, input: any, engine?: Engine) {
    this.assertLive(context);
    if(engine)this.bindMediation(engine,context);
    if (!Object.values(FIXTURES).some(a => a.operations.includes(command)) && !PROFILE_OPERATIONS.includes(command as any) && !BUILD_OPERATIONS.includes(command as any) && command !== BUILD_RECOVERY_OPERATION && !['adoption.prepare','adoption.review','content.review','assets.import','mediation.prepare','mediation.respond','reports.dispose','source.capture','source.bind','drift.check','drift.propose','drift.review','git.plan','git.stage','git.check','git.evidence','git.review','git.apply','git.finalize','git.transaction.inspect','git.transaction.recover'].includes(command)) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown broker operation.');
    if (!context.allowed_operations.includes(command)) fail('OPERATION_FORBIDDEN', 4, 'This fixture assignment does not allow the requested operation.');
    const assignment = this.assignments[context.grant_id];
    if((this.options.mediation && this.options.mediation.grants.some(g=>g.principal===context.principal_id) || engine?.mediation?.isExecutor(context.principal_id)) && !['status','inspect','conflicts','mediation.respond','approve','resolve'].includes(command)) fail('SELECTION_GRANT_FORBIDDEN',4,'The dedicated executor has no authoring, evidence, installation or release operation.');
    checkAssignment(context,command,input,engine,assignment,this);
  }
}

export function checkAssignment(context:SecurityContext,command:string,input:any,engine:Engine|undefined,assignment:Assignment,issuer:AuthorityIssuer){
    if (command === 'adoption.prepare') checkAssignment(context, 'layer.create', { record: input?.layer }, engine, assignment, issuer);
    if (command === 'adoption.review' && engine) {
      const proposal = engine.records[input?.proposal_ref];
      if (proposal?.type === 'adoption-proposal') checkAssignment(context, 'layer.publish', { ref: proposal.data.draft_ref }, engine, assignment, issuer);
    }
    recoveryInput(command, input);
    if (command.startsWith('layer.')) {
      const id = input?.record?.id ?? input?.ref?.split('@')[0];
      if (!id || ['__proto__', 'prototype', 'constructor'].includes(id)) fail('INVALID_ARGUMENT', 2, 'Supply a supported Layer identity.');
      if (context.layer_ids !== null && !context.layer_ids.includes(id)) fail('LAYER_SCOPE_FORBIDDEN', 4, 'Layer is outside the server-assigned task scope.');
      const layer: Layer | undefined = input?.record ?? (engine && input.ref ? engine.records[input.ref]?.data : undefined);
      if (layer?.owner !== undefined && layer.owner !== context.principal_id) fail('OWNER_FORBIDDEN', 4, 'Owner labels cannot replace the server-resolved fixture principal.');
      if(layer?.created_blocks?.some(b=>!b.parent||!context.create_under_block_ids?.includes(b.parent)))fail('BLOCK_SCOPE_FORBIDDEN',4,'Creation needs an explicit parent-scoped assignment.');
      const source = command === 'layer.restore' && engine ? restorationSource(engine, input, context.principal_id) : null;
      for (const proposed of [layer, source]) if(proposed){if(proposed.created_blocks?.some(b=>!b.parent||!context.create_under_block_ids?.includes(b.parent)))fail('BLOCK_SCOPE_FORBIDDEN',4,'Restored creation needs the currently assigned parent scope.');if(context.write_block_ids !== null && [...(proposed.changes ?? []), ...(proposed.acceptance ?? [])].some(c => !context.write_block_ids!.includes(c.block))) fail('BLOCK_SCOPE_FORBIDDEN', 4, 'A proposed write is outside the server-assigned Block scope.');}
    }
    if (command === 'approve' && !assignment.approvals?.includes(input?.record?.kind)) fail('AUTHORITY_FORBIDDEN', 4, 'This assignment cannot supply that kind of semantic endorsement.');
    if (command === 'validate'&&context.trust_mode==='local_fixture') {
      if (!assignment.executor || input?.evidence?.executor !== assignment.executor || input.evidence.results?.some((r: any) => r.method === 'review' && !assignment.reviewers?.includes(r.reviewer))) fail('EVIDENCE_PRODUCER_FORBIDDEN', 4, 'Evidence must be imported by the assigned fixture producer with its configured executor/reviewer labels.');
    }
    if(engine && ['strata/0.2-content-mediation-experimental','strata/0.3-block-lifecycle-experimental'].includes(engine.modelVersion()) && ['mediation.respond','approve','resolve','release'].includes(command))engine.mediation?.recheck(command,input);
    if (engine && ['release', 'resolve'].includes(command)) {
      const refs: string[] = command === 'resolve' ? input?.record?.approvals ?? [] : [...(input?.approvals ?? [])];
      if (command === 'release') {
        const composition = engine.records[input.target];
        for (const resolution of composition?.data?.resolutions ?? []) refs.push(...(engine.records[resolution]?.data?.approvals ?? []));
      }
      for (const ref of refs) {
        const approval = engine.records[ref];
        if (approval?.type === 'approval' && !issuer.active(approval.data.principal)) fail('ENDORSEMENT_REVOKED', 6, 'A pending publication depends on a suspended or expired fixture endorser.');
      }
    }
}
export type SafeAuditEvent = { event_id: string; operation_id: string; project_id: string; principal_id: string | null; policy_version: string | null; action: string; outcome: 'allowed' | 'denied' | 'committed'; reason: string | null; references: string[] };
export function auditEvent(context: SecurityContext | null, command: string, operationId: string, outcome: SafeAuditEvent['outcome'], reason: string | null = null): SafeAuditEvent {
  return { event_id: crypto.randomUUID(), operation_id: operationId, project_id: context?.project_id ?? LOCAL_PROJECT, principal_id: context?.principal_id ?? null, policy_version: context?.policy_version ?? null, action: (Object.values(FIXTURES).some(a => a.operations.includes(command)) || ['drift.revalidate','adoption.prepare','adoption.review','mediation.install','evidence.run','criterion.review','mediation.prepare','mediation.respond','reports.dispose','content.review','assets.import','source.capture','source.bind','drift.check','drift.propose','drift.review','git.plan','git.stage','git.check','git.evidence','git.review','git.apply','git.finalize','git.transaction.inspect','git.transaction.recover'].includes(command)) ? command : 'unsupported', outcome, reason, references: [] };
}
export function validateEnvelope(text: string): any {
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) fail('INVALID_ARGUMENT', 2, 'Request exceeds the local byte limit.');
  let body: any; try { body = JSON.parse(text); } catch { fail('INVALID_ARGUMENT', 2, 'Expected one JSON operation.'); }
  const stack = [{ value: body, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 20000 || depth > 32) fail('INVALID_ARGUMENT', 2, 'Request exceeds the local structure limit.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  if (!body || Array.isArray(body) || typeof body.command !== 'string' || !body.input || typeof body.input !== 'object' || Array.isArray(body.input) || Object.keys(body).some(k => !['command', 'input', 'options'].includes(k))) fail('INVALID_ARGUMENT', 2, 'Invalid operation envelope.');
  const options = body.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['dry_run', 'idempotency_key', 'fault'].includes(k)) || (options.dry_run !== undefined && typeof options.dry_run !== 'boolean') || (options.idempotency_key !== undefined && (typeof options.idempotency_key !== 'string' || !options.idempotency_key || options.idempotency_key.length > 128)) || (options.fault !== undefined && !['after-stage', 'after-commit'].includes(options.fault))) fail('INVALID_ARGUMENT', 2, 'Invalid local operation options.');
  return body;
}
