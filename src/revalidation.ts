import { z } from 'zod';
import { Engine } from './core.js';
import { MODEL, canonical, digest, fail, parse, type Records } from './model.js';
import { sourceHashSchema as hash, sourceRefSchema as ref, sourceTextSchema as text, sourceScopeSchema, sourceEntrySchema, gitObservationSchema, readSourceBinding, readBindingSource, sourceAuthorityScope, validateGitObservation } from './source-binding.js';
import { driftReportSchema } from './source-drift.js';
import { reconciliationProposalSchema, reconciliationReviewSchema, verifyDriftHistory } from './reconciliation.js';
import { acceptanceSchema, observationSchema, planSchema, stageSchema, gitCheckerSchema, targetSchema, resultSchema } from './git-record-schemas.js';
import { verifySourceBindingHistory } from './source-binding.js';
import { verifyGitAdoptionHistory } from './git-adoption.js';
import { retainedR1Closure, verifyR1SemanticHistory } from './reconciliation-completion-r1.js';

export const revalidationPinSchema = z.object({ ref: ref.max(256), sha256: hash }).strict();
const pin = revalidationPinSchema, timestamp = z.string().datetime(), attempt = z.string().uuid();
const criterion = resultSchema.omit({ passed: true, reviewer: true });
export const criterionAssertionSchema = z.object({ criterion_ref: text, accepted: z.literal(true), rationale: text }).strict();
export const revalidationRequestSchema = z.object({ review: pin, basis_evidence: pin, expected_observation_sha256: hash,
  criterion_reviews: z.array(criterionAssertionSchema).max(256) }).strict();
export type RevalidationRequest = z.infer<typeof revalidationRequestSchema>;
export function normalizeRevalidationRequest(input: unknown): RevalidationRequest {
  const request = parse(revalidationRequestSchema, input);
  unique(request.criterion_reviews.map(r => r.criterion_ref));
  request.criterion_reviews.sort((a,b) => a.criterion_ref.localeCompare(b.criterion_ref));
  return request;
}
export const revalidationAuthoritySchema = z.object({ account_id: text, principal_id: text, principal_kind: z.enum(['person','agent']),
  credential_epoch: z.number().int().positive(), policy_generation: z.number().int().positive(), policy_sha256: hash,
  account_generation: z.number().int().positive(), accounts_sha256: hash, grant_id: text, grant_scope_sha256: hash,
  repository_configuration_sha256: hash, responsible_scope: text, expires_at: timestamp }).strict();
export type RevalidationAuthority = z.infer<typeof revalidationAuthoritySchema>;
/** Session expiry can refresh on login; all retained authority identities must remain exact. */
export function revalidationAuthorityIdentity(authority:RevalidationAuthority) {
  const {expires_at:_,...identity}=authority;
  return identity;
}
export const revalidationBridgeSchema = z.object({ format: z.literal('revalidation-bridge/1'), model_version: z.literal(MODEL),
  project_id: text, repo_id: text, review: pin, proposal: pin, report: pin, binding: pin, basis_evidence: pin,
  plan: pin, stage: pin, base_source: pin, target: targetSchema, scope: sourceScopeSchema, criteria: z.array(criterion).max(256),
  regressions: z.array(text).max(64), acceptance_contract_sha256: hash, checker: gitCheckerSchema, oracle_sha256: hash,
  stage_tree_oid: text, stage_manifest_sha256: hash, historical_producer: acceptanceSchema.shape.producer,
  historical_reviewer: text, historical_policy_version: text, historical_review_trust: z.literal('local-fixture'),
  producer_id: text, authority: revalidationAuthoritySchema, legacy_evidence_role: z.literal('contract-basis-only') }).strict();
export type RevalidationBridge = z.infer<typeof revalidationBridgeSchema>;
const common = { model_version: z.literal(MODEL), project_id: text, repo_id: text, attempt_id: attempt, bridge_sha256: hash };
export const revalidationActionInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('drift.revalidate'), request: revalidationRequestSchema, bridge_sha256: hash }).strict(),
  z.object({ action: z.literal('revalidation.run'), attempt_id: attempt, bridge_sha256: hash, checker_sha256: hash, measured_input_sha256: hash }).strict(),
  z.object({ action: z.literal('revalidation.criterion-review'), attempt_id: attempt, bridge_sha256: hash,
    assertions: z.array(criterionAssertionSchema).max(256) }).strict(),
]);
export const revalidationAuthSchema = z.object({ format: z.literal('strata-revalidation-auth/1'), ...common,
  action: z.enum(['drift.revalidate','revalidation.run','revalidation.criterion-review']), action_input: revalidationActionInputSchema,
  input_sha256: hash, request_sha256: hash, authority: revalidationAuthoritySchema,
  issued_at: timestamp, expires_at: timestamp, trust: z.literal('host-authenticated') }).strict();
// Portable producer assets are data. History verification never evaluates their source.
export const revalidatorDescriptorSchema = z.object({ format: z.literal('strata-revalidator-descriptor/1'), id: text,
  profile_id: text, profile_sha256: hash, profile_archive: z.unknown(), checker: gitCheckerSchema,
  recognizer_source: text.max(256*1024), worker_source: z.string().min(1).max(256*1024), runner_source: z.string().min(1).max(256*1024),
  implementation_sha256: hash, oracle: z.unknown(), bounds: z.object({ milliseconds: z.literal(5000), old_generation_mib: z.literal(64),
    young_generation_mib: z.literal(16), ipc_bytes: z.literal(262144) }).strict() }).strict();
export type RevalidatorDescriptor = z.infer<typeof revalidatorDescriptorSchema>;
const regression = z.object({ id: text, passed: z.literal(true), preserved_entries: z.array(sourceEntrySchema).max(256),
  base_manifest_sha256: hash, stage_manifest_sha256: hash, observation_manifest_sha256: hash }).strict();
const checkObservationSchema=z.object({passed:z.boolean(),failure:text.nullable(),observations:z.record(z.string(),z.unknown())}).strict();
export const revalidationObservationsSchema=z.object({checks:z.record(z.string(),checkObservationSchema),oracle_sha256:hash}).strict();
export const revalidationRunSchema = z.object({ format: z.literal('git-revalidation-run/1'), ...common, bridge: revalidationBridgeSchema,
  pre_observation: gitObservationSchema, post_observation: gitObservationSchema, pre_observation_sha256: hash, post_observation_sha256: hash,
  descriptor: revalidatorDescriptorSchema, descriptor_sha256: hash, measured_input_sha256: hash,
  results: z.array(resultSchema).max(256), observations: revalidationObservationsSchema, observations_sha256: hash,
  regressions: z.array(regression).max(64), started_at: timestamp, finished_at: timestamp, producer: text,
  auth: pin, execution_authenticated: z.literal(true) }).strict();
export type RevalidationRun = z.infer<typeof revalidationRunSchema>;
export const revalidationCriterionReviewSchema = z.object({ format: z.literal('revalidation-criterion-review/1'), ...common,
  target: targetSchema, observation_sha256: hash, checker: gitCheckerSchema, assertions: z.array(criterionAssertionSchema).min(1).max(256),
  reviewer: text, auth: pin }).strict();
export const reconciliationCompletionSchema = z.object({ format: z.literal('reconciliation-completion/1'), ...common,
  action: z.literal('revalidate'), request: revalidationRequestSchema, bridge: revalidationBridgeSchema,
  final_observation: gitObservationSchema, observation_sha256: hash, run: pin, criterion_review: pin.nullable(), auth: pin,
  selected_checks_passed: z.literal(true), outcome: z.literal('revalidated-selected-checks'), completed_at: timestamp,
  git_finalization_ref: z.null(), successor_binding_ref: z.null(), source_binding_advanced: z.literal(false), release_changed: z.literal(false),
  behavior_verified: z.literal(false), limitations: z.array(text).max(256) }).strict();
export const REVALIDATION_SCHEMAS = { 'revalidation-auth': revalidationAuthSchema, 'git-revalidation-run': revalidationRunSchema,
  'revalidation-criterion-review': revalidationCriterionReviewSchema, 'reconciliation-completion': reconciliationCompletionSchema } as const;
export function revalidationSame(a: unknown,b: unknown,message = 'Revalidation pins or closure differ.') {
  if (canonical(a)!==canonical(b)) fail('REVALIDATION_MISMATCH',6,message);
}
const same = revalidationSame;
function unique(values: string[]) { if(new Set(values).size!==values.length) fail('REVALIDATION_COVERAGE',6,'Duplicate revalidation identities.'); }
export function recordPin(exact: string, data: unknown) { return {ref:exact,sha256:digest(data)}; }

/** Pure approved-context gate shared by runtime and portable historical checking. */
export function revalidationContext(records: Records, input: unknown, project: string) {
  const request = normalizeRevalidationRequest(input);
  const closure = retainedR1Closure(records,[request.review.ref,request.basis_evidence.ref]);
  const engine = new Engine(closure,{}, {projectId:project});
  verifyR1SemanticHistory(engine); verifySourceBindingHistory(closure,project); verifyDriftHistory(closure,project); verifyGitAdoptionHistory(closure,project);
  const read = (p: z.infer<typeof pin>, type: string) => {const data=engine.read(p.ref,type);same(digest(data),p.sha256);return data;};
  const review = parse(reconciliationReviewSchema,read(request.review,'reconciliation-review'));
  const proposal = parse(reconciliationProposalSchema,read({ref:review.proposal_ref,sha256:review.proposal_sha256},'reconciliation-proposal'));
  const report = parse(driftReportSchema,read({ref:review.report_ref,sha256:review.report_sha256},'drift-report'));
  const binding = readSourceBinding(engine,review.binding_ref), source=readBindingSource(engine,binding);
  same(digest(binding),review.binding_sha256);
  if(review.decision!=='approve_plan'||review.state!=='approved_plan'||proposal.action!=='revalidate'||review.questions.length||proposal.questions.length)
    fail('REVALIDATION_APPROVAL_REQUIRED',6,'An exact approved revalidate plan without unanswered questions is required.');
  if(proposal.layer_refs.length||proposal.patch_refs.length) fail('REVALIDATION_UNSUPPORTED',8,'Layer and patch handoffs are unsupported.');
  same([review.project_id,proposal.project_id,report.project_id,binding.payload.project_id],[project,project,project,project]);
  same(proposal.items,source.scope.items,'The full declared item scope is required.');
  same(proposal.paths,[...new Set(source.scope.mapping.flatMap(m=>m.paths))].sort(),'All mapped paths are required.');
  const target=engine.target(binding.payload.intent.release_ref), release=engine.read(binding.payload.intent.release_ref,'release');
  const exactTarget={ref:binding.payload.intent.release_ref,record_sha256:digest(release),snapshot_sha256:digest(target.snapshot),candidate_fingerprint:target.fingerprint};
  same(report.observed_intent,exactTarget,'The accepted Release must remain unchanged.');
  if(target.snapshot.model_version!==MODEL) fail('REVALIDATION_UNSUPPORTED',8,'Revalidation supports only explicit v0.1.');
  const observed=validateGitObservation(report.observation,source.scope);
  same(digest(observed),request.expected_observation_sha256);
  if(observed.trust!=='local-measurement'||observed.coherence!=='stable'||observed.unsupported.length||!report.coverage.scope_complete)
    fail('REVALIDATION_SOURCE_REQUIRED',6,'A complete stable supported local source observation is required.');
  const assessed=report.evidence.find(e=>e.ref===request.basis_evidence.ref);
  if(!proposal.evidence_refs.includes(request.basis_evidence.ref)||assessed?.kind!=='application'||assessed.record_sha256!==request.basis_evidence.sha256)
    fail('REVALIDATION_BASIS_REQUIRED',6,'Basis must be retained by both the exact proposal and report.');
  const basisType=closure[request.basis_evidence.ref]?.type;
  if(!['git-acceptance','git-application-observation'].includes(basisType))fail('REVALIDATION_UNSUPPORTED',8,'An unbridged legacy application basis is required.');
  const basis=parse(z.union([acceptanceSchema,observationSchema]),read(request.basis_evidence,basisType));
  const plan=parse(planSchema,engine.read(basis.plan_ref,'git-change-plan')), stage=parse(stageSchema,engine.read(basis.stage_ref,'git-patch-stage'));
  same([plan.binding_ref,plan.base_source_ref,plan.target,basis.target,basis.result_manifest_sha256,stage.result_manifest_sha256],
    [review.binding_ref,binding.payload.source_ref,exactTarget,exactTarget,observed.manifest_sha256,observed.manifest_sha256]);
  const criteria=report.coverage.criteria.map(criterion_ref=>{const [block,id]=criterion_ref.split('/acceptance.');const c=target.snapshot.blocks[block]?.acceptance[id];
    if(!c)fail('REVALIDATION_COVERAGE',6,'Selected criterion is absent.');return {criterion_ref,check:c.check,version:c.version,fixture:c.fixture,method:c.method};});
  same(plan.criteria,criteria,'Every selected criterion must be frozen in the application plan.'); unique(criteria.map(c=>c.criterion_ref));
  same(request.criterion_reviews.map(r=>r.criterion_ref),criteria.filter(c=>c.method==='review').map(c=>c.criterion_ref).sort(),'Exactly one explicit assertion per review criterion is required.');
  if(plan.regressions.some(id=>id!=='unrelated-byte-preservation'))fail('REVALIDATION_UNSUPPORTED',8,'Unknown frozen regression.');unique(plan.regressions);
  const responsible=sourceAuthorityScope(target.snapshot,source.scope);
  same(responsible,review.responsible_scope);
  return {request,closure,engine,review,proposal,report,binding,source,target:exactTarget,snapshot:target.snapshot,basis,plan,stage,criteria,responsible};
}
export type RevalidationContext = ReturnType<typeof revalidationContext>;
export function revalidationMeasuredInput(c:RevalidationContext) {
  return digest({observation_sha256:digest(c.report.observation),entries:c.report.observation.entries,checker:c.plan.checker,oracle_sha256:digest(c.plan.oracle)});
}
export function deriveRevalidationBridge(c:RevalidationContext,authority:RevalidationAuthority,producerId:string):RevalidationBridge {
  return parse(revalidationBridgeSchema,{format:'revalidation-bridge/1',model_version:MODEL,project_id:c.review.project_id,repo_id:c.review.repo_id,
    review:c.request.review,proposal:recordPin(c.review.proposal_ref,c.proposal),report:recordPin(c.review.report_ref,c.report),binding:recordPin(c.review.binding_ref,c.binding),
    basis_evidence:c.request.basis_evidence,plan:recordPin(c.basis.plan_ref,c.plan),stage:recordPin(c.basis.stage_ref,c.stage),base_source:recordPin(c.binding.payload.source_ref,c.source),
    target:c.target,scope:c.source.scope,criteria:c.criteria,regressions:c.plan.regressions,acceptance_contract_sha256:c.plan.acceptance_contract_sha256,
    checker:c.plan.checker,oracle_sha256:digest(c.plan.oracle),stage_tree_oid:c.stage.result_tree_oid,stage_manifest_sha256:c.stage.result_manifest_sha256,
    historical_producer:c.basis.producer,historical_reviewer:c.review.reviewer,historical_policy_version:c.review.policy_version,historical_review_trust:c.review.trust,
    producer_id:producerId,authority,legacy_evidence_role:'contract-basis-only'});
}
export function revalidationRegressions(c:RevalidationContext) {
  const write=new Set(c.stage.operations.map(op=>op.path));
  const preserved=c.source.entries.filter(e=>!write.has(e.path));
  for(const e of preserved)same(c.report.observation.entries.find(row=>row.path===e.path),e,'Measured preserved entries differ from their verified base/stage entries.');
  // verifyGitAdoptionHistory above independently reconstructs the entire retained stage.
  return c.plan.regressions.map(id=>({id,passed:true as const,preserved_entries:preserved,base_manifest_sha256:c.source.manifest_sha256,
    stage_manifest_sha256:c.stage.result_manifest_sha256,observation_manifest_sha256:c.report.observation.manifest_sha256}));
}
export function revalidationArchiveReferences(type:string,data:any):string[] {
  if(!Object.hasOwn(REVALIDATION_SCHEMAS,type))return [];
  const d:any=parse(REVALIDATION_SCHEMAS[type as keyof typeof REVALIDATION_SCHEMAS] as z.ZodType,data);
  if(type==='revalidation-auth')return [];
  if(type==='revalidation-criterion-review')return [d.auth.ref,d.target.ref];
  const bridge=d.bridge;const refs=[bridge.review.ref,bridge.proposal.ref,bridge.report.ref,bridge.binding.ref,bridge.basis_evidence.ref,bridge.plan.ref,bridge.stage.ref,bridge.base_source.ref,bridge.target.ref,d.auth.ref];
  if(type==='reconciliation-completion')refs.push(d.run.ref,...(d.criterion_review?[d.criterion_review.ref]:[]));
  return [...new Set(refs)].sort();
}
export function revalidationRequestDigest(request:RevalidationRequest,principal:string) { return digest({command:'drift.revalidate',input:request,principal}); }
export function completionProjection(ref:string,d:z.infer<typeof reconciliationCompletionSchema>) {
  return {ref,completion_ref:ref,run_ref:d.run.ref,auth_ref:d.auth.ref,state:'completed',completion:true,execution_authenticated:true,selected_checks_passed:true,
    observation_sha256:d.observation_sha256,source_binding_advanced:false,release_changed:false,behavior_verified:false,git_finalization_ref:null,successor_binding_ref:null,
    target:d.bridge.target,scope:d.bridge.scope,actor:d.bridge.authority.principal_id,limitations:d.limitations,live_source_checked:false};
}
/** Offline integrity relative to trusted retained history, never execution or active authority. */
export function verifyRevalidationHistory(records:Records,project:string,verifyProducer:(c:RevalidationContext,d:RevalidatorDescriptor,run:RevalidationRun)=>void) {
  const unexpired=(auth:any,at:string)=>{
    // Run receipts attest execution after it finishes; their expiry must still cover the claimed times.
    if(Date.parse(at)>=Date.parse(auth.expires_at))fail('REVALIDATION_AUTH_EXPIRED',6,'A required action receipt expired before execution or completion.');
  };
  const read=(p:z.infer<typeof pin>,type:string)=>{const stored=records[p.ref];if(!stored?.published||stored.type!==type)fail('REVALIDATION_CLOSURE',6,'A published typed predecessor is required.');
    same(p,recordPin(p.ref,stored.data));same(p.ref,type+'@'+digest(stored.data));return parse(REVALIDATION_SCHEMAS[type as keyof typeof REVALIDATION_SCHEMAS] as z.ZodType<any>,stored.data);};
  for(const [exact,stored]of Object.entries(records))if(Object.hasOwn(REVALIDATION_SCHEMAS,stored.type)) {
    const d:any=parse(REVALIDATION_SCHEMAS[stored.type as keyof typeof REVALIDATION_SCHEMAS] as z.ZodType,stored.data);
    if(!stored.published||d.project_id!==project)fail('REVALIDATION_CLOSURE',6,'Completion history must be published and project-bound.');same(exact,stored.type+'@'+digest(d));
    if(stored.type==='revalidation-auth') {
      same(d.input_sha256,digest(d.action_input));same(d.action,d.action_input.action);
      if(Date.parse(d.issued_at)>=Date.parse(d.expires_at)||Date.parse(d.expires_at)>Date.parse(d.authority.expires_at))fail('REVALIDATION_MISMATCH',6,'Action expiry is invalid.');
      continue;
    }
    const auth=read(d.auth,'revalidation-auth');same([auth.attempt_id,auth.bridge_sha256,auth.project_id,auth.repo_id],[d.attempt_id,d.bridge_sha256,d.project_id,d.repo_id]);
    if(stored.type==='revalidation-criterion-review') {same(auth.action_input,{action:'revalidation.criterion-review',attempt_id:d.attempt_id,bridge_sha256:d.bridge_sha256,assertions:d.assertions});same(d.reviewer,auth.authority.principal_id);continue;}
    same(d.bridge_sha256,digest(d.bridge));same(auth.authority,d.bridge.authority);
    const request=stored.type==='reconciliation-completion'?d.request:read(auth.action_input.action==='drift.revalidate'?d.auth:findCompletionAuth(records,d),'revalidation-auth').action_input.request;
    const c=revalidationContext(records,request,project);same(d.bridge,deriveRevalidationBridge(c,d.bridge.authority,d.bridge.producer_id));
    if(d.bridge.authority.principal_id!==c.review.reviewer||d.bridge.authority.responsible_scope!==c.responsible||!c.snapshot.authorities.scopes.some(s=>s.block===c.responsible&&s.selectors.includes(d.bridge.authority.principal_id)))fail('REVALIDATION_MISMATCH',6,'Named actor differs from the retained scope selector/reviewer.');
    same(auth.request_sha256,revalidationRequestDigest(c.request,d.bridge.authority.principal_id));
    if(stored.type==='git-revalidation-run') {
      verifyProducer(c,d.descriptor,d);
      same([d.pre_observation,d.post_observation,d.pre_observation_sha256,d.post_observation_sha256],[c.report.observation,c.report.observation,digest(c.report.observation),digest(c.report.observation)]);
      same(auth.action_input,{action:'revalidation.run',attempt_id:d.attempt_id,bridge_sha256:d.bridge_sha256,checker_sha256:c.plan.checker.sha256,measured_input_sha256:d.measured_input_sha256});
      same(d.producer,d.bridge.authority.principal_id);same(d.observations_sha256,digest(d.observations));same(d.descriptor_sha256,digest(d.descriptor));
      same(d.descriptor.checker,d.bridge.checker);same(d.descriptor.id,d.bridge.producer_id);same(d.descriptor.oracle,c.plan.oracle);
      same(d.descriptor.profile_sha256,digest(d.descriptor.profile_archive));
      same(d.measured_input_sha256,revalidationMeasuredInput(c));
      same(d.descriptor.implementation_sha256,digest({worker_source:d.descriptor.worker_source,runner_source:d.descriptor.runner_source,recognizer_source:d.descriptor.recognizer_source}));
      if(new TextEncoder().encode(canonical(d.observations)).byteLength>262144||Date.parse(d.finished_at)<Date.parse(d.started_at)||Date.parse(d.finished_at)-Date.parse(d.started_at)>5000+1000)fail('REVALIDATION_MISMATCH',6,'Run bounds differ.');
      unexpired(auth,d.started_at);unexpired(auth,d.finished_at);
      same(d.results.map(({passed,reviewer,...r}:any)=>r),c.criteria.filter(r=>r.method==='mechanical'));
      if(d.results.some((r:any)=>!r.passed||r.reviewer!==null))fail('REVALIDATION_FAILED',6,'Every mechanical criterion must pass.');
      same(Object.keys(d.observations.checks).sort(),[...new Set(c.criteria.filter(r=>r.method==='mechanical').map(r=>r.check))].sort());
      same(d.observations.oracle_sha256,c.plan.checker.oracle_sha256);
      for(const r of d.results)if(d.observations.checks[r.check]?.passed!==r.passed||d.observations.checks[r.check]?.failure!==null)fail('REVALIDATION_FAILED',6,'Mechanical result differs from its retained observation.');
      same(d.regressions,revalidationRegressions(c));
    } else {
      same(auth.action_input,{action:'drift.revalidate',request:c.request,bridge_sha256:d.bridge_sha256});
      same([d.final_observation,d.observation_sha256],[c.report.observation,digest(c.report.observation)]);
      const run=read(d.run,'git-revalidation-run');same([run.attempt_id,run.bridge_sha256,run.bridge,run.producer],[d.attempt_id,d.bridge_sha256,d.bridge,d.bridge.authority.principal_id]);
      const runAuth=read(run.auth,'revalidation-auth');same(runAuth.authority,auth.authority);same(runAuth.request_sha256,auth.request_sha256);
      unexpired(auth,d.completed_at);unexpired(runAuth,d.completed_at);
      if(c.request.criterion_reviews.length){if(!d.criterion_review)fail('REVALIDATION_COVERAGE',6,'Explicit criterion receipt is absent.');const review=read(d.criterion_review,'revalidation-criterion-review');
        same([review.attempt_id,review.bridge_sha256,review.target,review.observation_sha256,review.checker,review.assertions,review.reviewer],[d.attempt_id,d.bridge_sha256,c.target,d.observation_sha256,c.plan.checker,c.request.criterion_reviews,d.bridge.authority.principal_id]);
        const reviewAuth=read(review.auth,'revalidation-auth');same(reviewAuth.authority,auth.authority);same(reviewAuth.request_sha256,auth.request_sha256);
        unexpired(reviewAuth,d.completed_at);
      }else same(d.criterion_review,null);
      if(Date.parse(d.completed_at)<Date.parse(run.finished_at)||Date.parse(d.completed_at)>Date.parse(auth.expires_at))fail('REVALIDATION_MISMATCH',6,'Completion time differs from execution/action expiry.');
    }
  }
  for(const [exact,stored]of Object.entries(records))if(Object.hasOwn(REVALIDATION_SCHEMAS,stored.type)&&stored.type!=='reconciliation-completion') {
    const d=stored.data,completions=Object.values(records).filter(r=>r.type==='reconciliation-completion'&&r.data.attempt_id===d.attempt_id&&r.data.bridge_sha256===d.bridge_sha256);
    if(completions.length!==1)fail('REVALIDATION_CLOSURE',6,'Each runtime attempt must have one atomic retained completion.');
    const completion=completions[0].data;
    const referenced=stored.type==='git-revalidation-run'?completion.run.ref===exact:stored.type==='revalidation-criterion-review'?completion.criterion_review?.ref===exact:
      [completion.auth.ref,records[completion.run.ref]?.data.auth.ref,completion.criterion_review?records[completion.criterion_review.ref]?.data.auth.ref:null].includes(exact);
    if(!referenced)fail('REVALIDATION_CLOSURE',6,'Detached runtime receipt is not an atomic completion predecessor.');
  }
  return {verified:true,historical_completion_verified:Object.values(records).some(r=>r.type==='reconciliation-completion'),live_authority_checked:false,live_source_checked:false};
}
function findCompletionAuth(records:Records,run:any) {
  const match=Object.entries(records).find(([,r])=>r.type==='revalidation-auth'&&r.data.action==='drift.revalidate'&&r.data.attempt_id===run.attempt_id&&r.data.bridge_sha256===run.bridge_sha256);
  if(!match)fail('REVALIDATION_CLOSURE',6,'Run requires its exact initiating action.');return recordPin(match[0],match[1].data);
}
