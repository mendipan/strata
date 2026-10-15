import { z } from 'zod';
import type { Engine } from './core.js';
import { canonical, digest, fail, parse, StrataError } from './model.js';
import { buildPinSchema, buildProfileRecordSchema, buildSelectionSchema, buildStartInputSchema, buildSupportingRef, compatibilityReportSchema, releaseBuildBindingSchema } from './build-contracts.js';
import { resolveBuildProfile, type BuildRepositoryLookup } from './build-compatibility.js';
import { inspectReleasePublication, type PublicationContext } from './build-publication.js';
import { preflightLocalHost, type HostEnvironment } from './build-host.js';
import { assertFlatOutputNames, LocalBuildOutput, LOCAL_OUTPUT_LIMITS, type OutputAllocation } from './build-output.js';
import { runNodeCommand, type OperationCall } from './commands/node.js';
import { hostRunSchema } from './auth/records.js';
import type { Realization } from './profile.js';
import { describeBuildOptions } from './build-options.js';
import { profileFor } from './profiles.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
const fileSchema = z.object({ file_id: hash, name: z.string().max(128), bytes: z.number().int().nonnegative().max(LOCAL_OUTPUT_LIMITS.total_bytes), sha256: hash }).strict();
const allocationSchema = z.object({ relative: z.string().regex(/^[a-f0-9]{64}[\\/][a-f0-9]{64}$/), identity: hash }).strict();
const hostSchema = z.object({ label: z.string().min(1).max(80), os: z.string().max(32), arch: z.string().max(32), node_version: z.string().max(128).nullable(),
  toolchains: z.array(z.object({ id, version: z.string().max(128) }).strict()).max(16),
  runner: z.object({ id, profile_ids: z.array(z.string().max(128)).max(16) }).strict().nullable() }).strict();
export const buildPlanSchema = z.object({
  format: z.literal('strata-build-plan/1'), project_id: id, repository_id: id, selection: buildSelectionSchema,
  source_generation: z.number().int().nonnegative(), release: buildPinSchema, composition: buildPinSchema, validation: buildPinSchema,
  approvals: z.array(buildPinSchema).max(128), publication_closure: z.array(buildPinSchema).max(1000),
  source_trust: z.enum(['local-fixture', 'host-authenticated', 'legacy-history-authenticated-authoring']),
  contract: buildPinSchema, binding: buildPinSchema, profile: buildPinSchema, candidate: hash,
  materializer: z.object({ id: z.literal('collection-host/1'), archive_sha256: hash }).strict(),
  destination_sha256: hash, policy_sha256: hash, environment_sha256: hash,
  output_root: z.object({ identity: hash, protection_sha256: hash }).strict(), environment: hostSchema,
  compatibility: compatibilityReportSchema
}).strict();
export const BUILD_PHASES = ['accepted', 'materializing', 'exporting', 'verifying_bytes', 'checking', 'completed', 'failed', 'interrupted', 'output_incomplete'] as const;
export const buildRunSchema = z.object({
  format: z.literal('strata-build-run/1'), build_id: hash, request_key: z.string().min(1).max(256), request_sha256: hash,
  project_id: id, repository_id: id, actor: id, plan_sha256: hash, plan: buildPlanSchema,
  phase: z.enum(BUILD_PHASES), events: z.array(z.object({ sequence: z.number().int().nonnegative(), phase: z.enum(BUILD_PHASES), at: z.string().datetime() }).strict()).min(1).max(16),
  allocation: allocationSchema.nullable(), realization: buildPinSchema.nullable(), output_tree: hash.nullable(),
  host_run: buildPinSchema.nullable(), inventory: z.array(fileSchema).max(LOCAL_OUTPUT_LIMITS.files + 1),
  verification: z.object({ bytes: z.boolean(), mechanical: z.boolean().nullable(), fresh_semantic_validation: z.literal(false) }).strict(),
  error: z.object({ code: z.string().max(128), message: z.string().max(1024) }).strict().nullable()
}).strict();
export type BuildPlan = z.infer<typeof buildPlanSchema>;
export type BuildRun = z.infer<typeof buildRunSchema>;
export const S2_BUILD_SCHEMAS = { 'build-plan': buildPlanSchema, 'build-run': buildRunSchema };
/** S1 supplies durable atomic admission/CAS. This module does not create a second repository store.
 * accept must index request_key by authenticated project/repository/actor and refuse mismatched payloads.
 * replace must commit the whole strictly parsed run and ordered event atomically, with bounded capacity.
 */
export interface BuildAttemptStore {
  accept(run: BuildRun): Promise<{ created: boolean; run: BuildRun }>;
  request(project_id: string, repository_id: string, actor: string, request_key: string): Promise<BuildRun | null>;
  get(build_id: string): Promise<BuildRun | null>;
  replace(run: BuildRun, expected_run_sha256: string): Promise<void>;
  pending(project_id: string, repository_id: string): Promise<BuildRun[]>;
}
export type BuildAuthority = { actor: string; project_id: string; repository_id: string; policy_sha256: string };
export type BuildReadContext = { engine: Engine; publication: PublicationContext; source_generation: number };
export type RegistrationLookup = {
  build_id: string; project_id: string; repository_id: string; actor: string;
  command: 'realization.register'; child_key: string;
};
export type RegistrationOutcome =
  | { state: 'committed'; command: 'realization.register'; child_key: string; input_sha256: string; ref: string }
  | { state: 'not_committed' }
  | { state: 'unknown' };
export type MeasurementLookup = Omit<RegistrationLookup,'command'> & {command:'evidence.run'};
export type MeasurementOutcome = {state:'committed';command:'evidence.run';child_key:string;input_sha256:string;ref:string}|{state:'not_committed'}|{state:'unknown'};
export type BuildDependencies = {
  project_id: string; repository_id: string; lookup: BuildRepositoryLookup; store: BuildAttemptStore;
  readContext(): Promise<BuildReadContext>;
  // Adapter resolves the current authenticated actor/policy, never client JSON claims.
  authorize(action: 'prepare' | 'start' | 'materialize' | 'register' | 'check' | 'outputs' | 'inspect' | 'reconcile', plan: BuildPlan | null): Promise<BuildAuthority>;
  host(): Promise<HostEnvironment>; output: LocalBuildOutput;
  // S3 supplies repository-bound child operation dispatch with deterministic idempotency keys.
  operation(command: string, input: unknown, child_key: string): Promise<any>;
  // Read-only receipt lookup, never operation replay. Missing receipts alone mean unknown;
  // not_committed requires an authoritative settled outcome with no in-flight/committed effect.
  lookupRegistration?: (input: RegistrationLookup) => Promise<RegistrationOutcome>;
  lookupMeasurement?: (input:MeasurementLookup)=>Promise<MeasurementOutcome>;
  // Internally allocated runner slot; callback must use authorized evidence.run and retain its receipt.
  runChecks(input: { build_id: string; target: string; profile: 'collection-host/1'; allocation: OutputAllocation; child_key: string }): Promise<{ ref: string; run: unknown; checks_passed: boolean }>;
  now?: () => Date;
};
const terminal = new Set<BuildRun['phase']>(['completed', 'failed', 'interrupted', 'output_incomplete']);
class BuildOutcomeUncertain extends Error {
  constructor(readonly cause: unknown) { super('Build outcome requires read-only reconciliation.'); }
}
const registrationKey = (build_id: string) => digest({ build: build_id, step: 'realization.register' });
const transitions: Record<BuildRun['phase'], readonly BuildRun['phase'][]> = {
  accepted: ['materializing', 'failed', 'interrupted'], materializing: ['exporting', 'failed', 'interrupted'],
  exporting: ['verifying_bytes', 'failed', 'output_incomplete', 'interrupted'], verifying_bytes: ['checking', 'completed', 'failed', 'interrupted'],
  checking: ['verifying_bytes', 'failed', 'interrupted'], completed: [], failed: [], interrupted: [], output_incomplete: []
};
export function assertBuildRun(run: unknown): BuildRun {
  const r = parse(buildRunSchema, run);
  if (r.plan_sha256 !== digest(r.plan) || r.project_id !== r.plan.project_id || r.repository_id !== r.plan.repository_id || r.build_id !== digest({ project_id: r.project_id, repository_id: r.repository_id, actor: r.actor, request_key: r.request_key, request_sha256: r.request_sha256 })) fail('BUILD_RUN_CORRUPT', 6, 'Build attempt identity or plan pin is invalid.');
  if (r.request_sha256 !== digest({ selection: r.plan.selection, expected_plan_sha256: r.plan_sha256 }) || r.events[0].phase !== 'accepted' || r.phase !== r.events.at(-1)!.phase || r.events.some((e, n) => e.sequence !== n || (n > 0 && !transitions[r.events[n - 1].phase].includes(e.phase)))) fail('BUILD_RUN_CORRUPT', 6, 'Build attempt transitions or request binding are invalid.');
  if (r.allocation && r.allocation.relative.split(/[\\/]/).join('/') !== digest(r.repository_id) + '/' + r.build_id) fail('BUILD_RUN_CORRUPT', 6, 'Output allocation belongs to another build or repository.');
  if (new Set(r.inventory.map(f => f.file_id)).size !== r.inventory.length || r.inventory.some(f => f.file_id !== digest({ build_id: r.build_id, name: f.name }))) fail('BUILD_RUN_CORRUPT', 6, 'Output file IDs are not bound to this build.');
  const p = r.plan, c = p.compatibility;
  if (p.selection.release_ref !== p.release.ref || p.selection.profile_ref !== p.profile.ref || c.target_ref !== p.release.ref || c.target_sha256 !== p.release.sha256 || c.contract_ref !== p.contract.ref || c.contract_sha256 !== p.contract.sha256 || !c.repository_valid || c.materialization_supported !== true || c.runnable_here !== true || c.checks.some(check => check.state !== 'satisfied') || !c.normalized_profile || c.normalized_sha256 !== digest(c.normalized_profile) || c.normalized_profile.materializer.id !== p.materializer.id || c.normalized_profile.materializer.archive_sha256 !== p.materializer.archive_sha256) fail('BUILD_RUN_CORRUPT', 6, 'Retained plan does not bind its exact source, profile and compatibility result.');
  if (r.phase === 'completed' && (!r.verification.bytes || r.verification.mechanical !== true || !r.host_run || !r.realization || !r.allocation || !r.inventory.length || r.error)) fail('BUILD_RUN_CORRUPT', 6, 'Completed build lacks retained verification.');
  return r;
}
export class LocalBuildCoordinator {
  private active = new Set<string>();
  constructor(readonly deps: BuildDependencies) {}
  private async authority(action: Parameters<BuildDependencies['authorize']>[0], plan: BuildPlan | null) {
    const a = await this.deps.authorize(action, plan);
    if (a.project_id !== this.deps.project_id || a.repository_id !== this.deps.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Build authorization belongs to another repository.');
    if (plan && a.policy_sha256 !== plan.policy_sha256) fail('BUILD_PLAN_STALE', 5, 'Current operational policy changed; prepare a new plan.');
    return a;
  }
  async prepare(input: unknown): Promise<{ plan: BuildPlan; plan_sha256: string }> {
    const selection = parse(buildSelectionSchema, input), authority = await this.authority('prepare', null);
    if (selection.destination.slot_id !== this.deps.output.slot.id) fail('OUTPUT_SLOT_UNAVAILABLE', 8, 'Choose a configured Local output slot.');
    const source = await this.deps.readContext();
    if (source.engine.options.projectId !== this.deps.project_id || source.publication.project_id !== this.deps.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Build source context belongs to another project.');
    const publication = inspectReleasePublication(source.publication, selection.release_ref);
    if (publication.state !== 'approved') fail(publication.code, 8, publication.message);
    if (publication.closure.some(pin => digest(source.engine.read(pin.ref)) !== pin.sha256)) fail('BUILD_SOURCE_PIN_MISMATCH', 6, 'Support engine differs from admitted publication history.');
    const lookup = await this.deps.lookup.compatibility(selection.release_ref);
    if (lookup.contract_binding !== 'post_publication_adoption') fail('BUILD_CONTRACT_BINDING_MISSING', 8, 'Release requires its exact post-publication adoption binding.');
    const context = lookup.context, binding = parse(releaseBuildBindingSchema, lookup.binding.record);
    if (context.project_id !== this.deps.project_id || context.repository_id !== this.deps.repository_id || binding.project_id !== this.deps.project_id || binding.repository_id !== this.deps.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Compatibility binding belongs to another repository.');
    if (digest(binding) !== lookup.binding.sha256 || buildSupportingRef(binding) !== lookup.binding.ref || canonical(binding.release) !== canonical(publication.release) || canonical(binding.contract) !== canonical({ ref: context.contract.ref, sha256: context.contract.sha256 })) fail('BUILD_BINDING_PIN_MISMATCH', 6, 'Adoption does not bind these exact Release and contract bytes.');
    const profile = await this.deps.lookup.profile(selection.profile_ref), record = parse(buildProfileRecordSchema, profile.record);
    if (record.project_id !== this.deps.project_id || record.repository_id !== this.deps.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Profile belongs to another repository.');
    if (profile.ref !== selection.profile_ref || digest(record) !== profile.sha256 || buildSupportingRef(record) !== profile.ref) fail('BUILD_PROFILE_PIN_MISMATCH', 6, 'Saved profile bytes differ from their selected exact pin.');
    const { format, project_id, repository_id, previous, author, auth_receipt, derived_from, ...choices } = record;
    const resolved = resolveBuildProfile(context, choices, { engine: source.engine, ref: selection.release_ref });
    const blocker = resolved.report.checks.find(c => c.state !== 'satisfied');
    if (blocker || !resolved.report.repository_valid || resolved.report.materialization_supported !== true || !resolved.options) fail(blocker?.code ?? 'BUILD_UNSUPPORTED', 8, blocker?.message ?? 'Selected profile cannot materialize this Release.', resolved.report);
    const host = await preflightLocalHost(await this.deps.host(), this.deps.output, resolved.options.requirements);
    if (!host.verify || !host.output) fail(host.blockers[0]?.code ?? 'HOST_UNAVAILABLE', 8, 'Local Studio host is not ready for a verified build.', host);
    resolved.report.runnable_here = true;
    const realized = source.engine.realize(selection.release_ref, 'collection-host/1'); assertFlatOutputNames(realized.files);
    const plan = parse(buildPlanSchema, {
      format: 'strata-build-plan/1', project_id: this.deps.project_id, repository_id: this.deps.repository_id, selection,
      source_generation: source.source_generation, release: publication.release, composition: publication.composition, validation: publication.validation,
      approvals: publication.approvals, publication_closure: publication.closure, source_trust: publication.source_trust,
      contract: { ref: context.contract.ref, sha256: context.contract.sha256 }, binding: { ref: lookup.binding.ref, sha256: lookup.binding.sha256 }, profile: { ref: profile.ref, sha256: profile.sha256 },
      candidate: realized.candidate, materializer: { id: 'collection-host/1', archive_sha256: resolved.options.archive_sha256 },
      destination_sha256: digest({ kind: 'local', slot_id: host.slot_id, slot_label: host.slot_label, host_label: host.host.label, output_layout: resolved.options.output_layout, run_application: false, serve_application: false }),
      policy_sha256: authority.policy_sha256, environment_sha256: host.fingerprint, output_root: host.output, environment: host.host, compatibility: resolved.report
    });
    return { plan, plan_sha256: digest(plan) };
  }
  private async advance(run: BuildRun, phase: BuildRun['phase'], patch: Partial<BuildRun> = {}): Promise<BuildRun> {
    const next = assertBuildRun({ ...run, ...patch, phase, events: [...run.events, { sequence: run.events.length, phase, at: (this.deps.now?.() ?? new Date()).toISOString() }] });
    try { await this.deps.store.replace(next, digest(run)); }
    catch (error) { throw new BuildOutcomeUncertain(error); }
    return next;
  }
  private async pendingOutcome(run: BuildRun): Promise<BuildRun> {
    const error = { code: 'BUILD_RECONCILIATION_REQUIRED', message: 'Outcome is unknown; reconcile original child receipts before closing this attempt. No effects were rerun.' };
    if (canonical(run.error) === canonical(error)) return run;
    const next = assertBuildRun({ ...run, error });
    await this.deps.store.replace(next, digest(run));
    return next;
  }
  private async recoverRegistration(run: BuildRun): Promise<{ realization: BuildRun['realization']; output_tree: string | null } | null> {
    const lookup = this.deps.lookupRegistration;
    if (!lookup) return null;
    const request: RegistrationLookup = { build_id: run.build_id, project_id: run.project_id, repository_id: run.repository_id, actor: run.actor, command: 'realization.register', child_key: registrationKey(run.build_id) };
    const outcome = await lookup(request);
    if (outcome.state === 'unknown') return null;
    if (outcome.state === 'not_committed') return { realization: null, output_tree: null };
    if (outcome.command !== request.command || outcome.child_key !== request.child_key) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Recovered receipt does not belong to the original registration key.');
    const record = await this.deps.operation('inspect', { type: 'realization', ref: outcome.ref }, digest({ build: run.build_id, step: 'inspect-realization' })) as Realization;
    const source = await this.deps.readContext();
    if (source.engine.options.projectId !== run.project_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Recovery engine belongs to another project.');
    const expected = source.engine.realize(run.plan.release.ref, 'collection-host/1');
    if (outcome.input_sha256 !== digest({ record }) || canonical(record) !== canonical(expected) || record.target !== run.plan.release.ref || record.candidate !== run.plan.candidate || record.profile_id !== 'collection-host/1' || record.profile !== run.plan.materializer.archive_sha256) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Recovered registration does not bind the exact accepted realization.');
    return { realization: { ref: outcome.ref, sha256: digest(record) }, output_tree: record.output_tree };
  }
  private async recoverMeasurement(run:BuildRun):Promise<Partial<BuildRun>|null> {
    if(!this.deps.lookupMeasurement||!run.realization||!run.allocation)return null;
    const child_key=digest({build:run.build_id,step:'evidence.run'}),outcome=await this.deps.lookupMeasurement({build_id:run.build_id,project_id:run.project_id,repository_id:run.repository_id,actor:run.actor,command:'evidence.run',child_key});
    if(outcome.state==='unknown')return null;
    if(outcome.state==='not_committed')return {};
    const input={target:run.plan.release.ref,profile:run.plan.materializer.id,slot:'build-'+digest({build:run.build_id,allocation:run.allocation})};
    if(outcome.command!=='evidence.run'||outcome.child_key!==child_key||outcome.input_sha256!==digest(input))fail('BUILD_CHILD_RECEIPT_MISMATCH',6,'Measurement recovery differs from the original finite runner request.');
    const receipt=parse(hostRunSchema,await this.deps.operation('inspect',{type:'host-run',ref:outcome.ref},digest({build:run.build_id,step:'inspect-host-run'})));
    const realization=await this.deps.operation('inspect',{type:'realization',ref:run.realization.ref},digest({build:run.build_id,step:'inspect-realization'})) as Realization;
    if(outcome.ref!=='host-run@'+digest(receipt)||digest(realization)!==run.realization.sha256||receipt.project_id!==run.project_id||receipt.producer!==run.actor||receipt.realization!==run.realization.ref||receipt.candidate!==run.plan.candidate||receipt.profile_id!==run.plan.materializer.id||receipt.profile!==run.plan.materializer.archive_sha256||receipt.output_tree!==run.output_tree)fail('BUILD_RUN_RECEIPT_MISMATCH',6,'Recovered measurement does not bind the exact retained Build.');
    const expected=[...new Map(realization.coverage.flatMap(c=>c.checks.filter(k=>k.method==='mechanical').map(k=>[canonical({check:k.check,version:k.version,fixture:k.fixture}),{check:k.check,version:k.version,fixture:k.fixture}]))).values()];
    if(!expected.length||canonical(expected.map(canonical).sort())!==canonical(receipt.results.map(({passed,...key})=>canonical(key)).sort()))fail('BUILD_RUN_RECEIPT_MISMATCH',6,'Recovered measurement lacks exact mechanical coverage.');
    return {host_run:{ref:outcome.ref,sha256:digest(receipt)},verification:{...run.verification,mechanical:receipt.results.every(r=>r.passed)}};
  }
  private async recheck(run: BuildRun) {
    const current = await this.prepare(run.plan.selection);
    // Child writes legitimately advance repository generation. Immutable source/profile/policy/host
    // pins must still be identical at every privileged step; dispatch owns the current generation CAS.
    if (canonical({ ...current.plan, source_generation: run.plan.source_generation }) !== canonical(run.plan)) fail('BUILD_PLAN_STALE', 5, 'Pinned build inputs or host readiness changed during execution.');
  }
  private async verify(run: BuildRun, executing = true) {
    await this.authority('outputs', executing ? run.plan : null);
    if (!run.realization || !run.allocation) fail('OUTPUT_INCOMPLETE', 9, 'Build has no retained realization output.');
    const record = await this.deps.operation('inspect', { type: 'realization', ref: run.realization.ref }, digest({ build: run.build_id, step: 'inspect-realization' })) as Realization;
    if (digest(record) !== run.realization.sha256 || record.target !== run.plan.release.ref || record.profile_id !== 'collection-host/1' || record.profile !== run.plan.materializer.archive_sha256 || record.candidate !== run.plan.candidate || record.output_tree !== run.output_tree) fail('STALE_REALIZATION', 6, 'Output realization does not match the build plan.');
    return this.deps.output.inventory(run.allocation, run.build_id, run.realization.ref, record);
  }
  async start(input: unknown, requestKey: string): Promise<BuildRun> {
    const request = parse(buildStartInputSchema, input), authority = await this.authority('start', null), request_sha256 = digest(request);
    if (typeof requestKey !== 'string' || !requestKey.length || requestKey.length > 256) fail('BUILD_REQUEST_KEY_REQUIRED', 2, 'A bounded original authenticated request key is required.');
    const earlier = await this.deps.store.request(this.deps.project_id, this.deps.repository_id, authority.actor, requestKey);
    if (earlier) {
      const prior = assertBuildRun(earlier);
      if (prior.project_id !== this.deps.project_id || prior.repository_id !== this.deps.repository_id || prior.actor !== authority.actor || prior.request_key !== requestKey || prior.request_sha256 !== request_sha256) fail('BUILD_REQUEST_CONFLICT', 5, 'Original request key belongs to a different build payload.');
      return prior;
    }
    const prepared = await this.prepare(request.selection);
    const current = await this.authority('start', prepared.plan);
    if (current.actor !== authority.actor) fail('BUILD_AUTHORITY_CHANGED', 4, 'Authenticated actor changed during dispatch.');
    if (request.expected_plan_sha256 !== prepared.plan_sha256) fail('BUILD_PLAN_STALE', 5, 'Selection, source, policy or host changed; prepare a new exact plan.');
    const build_id = digest({ project_id: this.deps.project_id, repository_id: this.deps.repository_id, actor: authority.actor, request_key: requestKey, request_sha256 });
    const draft = assertBuildRun({ format: 'strata-build-run/1', build_id, request_key: requestKey, request_sha256,
      project_id: this.deps.project_id, repository_id: this.deps.repository_id, actor: authority.actor,
      plan_sha256: prepared.plan_sha256, plan: prepared.plan, phase: 'accepted', events: [{ sequence: 0, phase: 'accepted', at: (this.deps.now?.() ?? new Date()).toISOString() }],
      allocation: null, realization: null, output_tree: null, host_run: null, inventory: [], verification: { bytes: false, mechanical: null, fresh_semantic_validation: false }, error: null });
    const accepted = await this.deps.store.accept(draft);
    let run = assertBuildRun(accepted.run);
    if (run.request_sha256 !== request_sha256 || run.actor !== authority.actor || run.project_id !== this.deps.project_id || run.repository_id !== this.deps.repository_id) fail('BUILD_REQUEST_CONFLICT', 5, 'Original request key belongs to a different build payload.');
    if (!accepted.created) return run;
    this.active.add(build_id);
    try {
      const rechecked = await this.prepare(request.selection);
      if (rechecked.plan_sha256 !== run.plan_sha256) fail('BUILD_PLAN_STALE', 5, 'Build plan changed before dispatch.');
      const allocation = await this.deps.output.allocate(this.deps.repository_id, build_id, run.plan.output_root);
      run = await this.advance(run, 'materializing', { allocation });
      const call: OperationCall = async (command, childInput) => {
        await this.recheck(run);
        const actor = await this.authority(command === 'realization.register' ? 'register' : 'materialize', run.plan);
        if (actor.actor !== run.actor) fail('BUILD_AUTHORITY_CHANGED', 4, 'Authenticated actor changed during dispatch.');
        await this.deps.output.directory(allocation);
        let result;
        try { result = await this.deps.operation(command, childInput, digest({ build: build_id, step: command })); }
        catch (error) { if (command === 'realization.register') throw new BuildOutcomeUncertain(error); throw error; }
        if (command === 'materialize') {
          assertFlatOutputNames(result.files);
          if (result.target !== run.plan.release.ref || result.candidate !== run.plan.candidate || result.profile !== run.plan.materializer.archive_sha256 || result.profile_id !== 'collection-host/1') fail('STALE_REALIZATION', 6, 'Materialized bytes do not match the accepted plan.');
          run = await this.advance(run, 'exporting');
        } else if (command === 'realization.register') {
          // Retain the exact ref before any filesystem export effects.
          try {
            const next = assertBuildRun({ ...run, realization: { ref: result.ref, sha256: digest(childInput.record) }, output_tree: childInput.record.output_tree });
            await this.deps.store.replace(next, digest(run)); run = next;
          }
          catch (error) { throw new BuildOutcomeUncertain(error); }
        }
        return result;
      };
      await runNodeCommand(this.deps.output.slot.root, call, 'materialize', { target: run.plan.release.ref, profile: 'collection-host/1', out: allocation.relative });
      run = await this.advance(run, 'verifying_bytes');
      await this.verify(run);
      await this.recheck(run);
      const checkerAuthority = await this.authority('check', run.plan);
      if (checkerAuthority.actor !== run.actor) fail('BUILD_AUTHORITY_CHANGED', 4, 'Authenticated actor changed during dispatch.');
      const environment = await preflightLocalHost(await this.deps.host(), this.deps.output, describeBuildOptions(profileFor('collection-host/1')).requirements);
      if (!environment.verify || environment.fingerprint !== run.plan.environment_sha256) fail('BUILD_PLAN_STALE', 5, 'Host readiness changed before finite checks.');
      run = await this.advance(run, 'checking', { verification: { ...run.verification, bytes: true } });
      let measured;
      try { measured=await this.deps.runChecks({ build_id, target: run.plan.release.ref, profile: 'collection-host/1', allocation, child_key: digest({ build: build_id, step: 'evidence.run' }) }); }
      catch(error) {throw new BuildOutcomeUncertain(error);}
      const receipt = parse(hostRunSchema, measured.run);
      const retained = await this.deps.operation('inspect', { type: 'host-run', ref: measured.ref }, digest({ build: build_id, step: 'inspect-host-run' }));
      if (measured.ref !== 'host-run@' + digest(receipt) || canonical(retained) !== canonical(receipt) || receipt.project_id !== run.project_id || receipt.realization !== run.realization!.ref || receipt.candidate !== run.plan.candidate || receipt.profile !== run.plan.materializer.archive_sha256 || receipt.profile_id !== 'collection-host/1' || receipt.output_tree !== run.output_tree) fail('BUILD_RUN_RECEIPT_MISMATCH', 6, 'Mechanical receipt does not bind this retained build realization.');
      const record = await this.deps.operation('inspect', { type: 'realization', ref: run.realization!.ref }, digest({ build: build_id, step: 'inspect-realization' })) as Realization;
      const expected = [...new Map(record.coverage.flatMap(c => c.checks.filter(k => k.method === 'mechanical').map(k => [canonical({ check: k.check, version: k.version, fixture: k.fixture }), { check: k.check, version: k.version, fixture: k.fixture }]))).values()];
      const observed = receipt.results.map(({ passed, ...key }) => key);
      if (!expected.length || canonical(expected.map(canonical).sort()) !== canonical(observed.map(canonical).sort())) fail('BUILD_RUN_RECEIPT_MISMATCH', 6, 'Mechanical receipt lacks exact criterion coverage.');
      const passed = receipt.results.every(r => r.passed) && measured.checks_passed;
      // Retain failed mechanical observations too; files may remain available with failed status.
      run = await this.advance(run, 'verifying_bytes', { host_run: { ref: measured.ref, sha256: digest(receipt) }, verification: { ...run.verification, mechanical: passed } });
      const inventory = await this.verify(run);
      if (!passed) {
        run = await this.advance(run, 'failed', { inventory, verification: { ...run.verification, bytes: true }, error: { code: 'BUILD_CHECKS_FAILED', message: 'Files verified; finite mechanical checks failed.' } });
      } else run = await this.advance(run, 'completed', { inventory, verification: { bytes: true, mechanical: true, fresh_semantic_validation: false } });
      return run;
    } catch (e) {
      // A failed durable transition is an unknown outcome. Never report a memory-only terminal state.
      const retained = await this.deps.store.get(build_id);
      if (!retained) throw e;
      run = assertBuildRun(retained);
      if (terminal.has(run.phase)) return run;
      if (e instanceof BuildOutcomeUncertain) return await this.pendingOutcome(run);
      const incomplete = e instanceof StrataError && e.code === 'OUTPUT_INCOMPLETE';
      return await this.advance(run, incomplete ? 'output_incomplete' : 'failed', { inventory: [], verification: { ...run.verification, bytes: false },
        error: { code: e instanceof StrataError ? e.code : 'BUILD_STEP_FAILED', message: incomplete ? 'Registered realization export is incomplete; reconcile this attempt before an explicit fresh retry.' : 'Build step failed; inspect the retained attempt before an explicit fresh retry.' } });
    } finally { this.active.delete(build_id); }
  }
  async inspect(buildId: string): Promise<BuildRun> {
    await this.authority('inspect', null);
    const run = await this.deps.store.get(buildId);
    if (!run || run.project_id !== this.deps.project_id || run.repository_id !== this.deps.repository_id) fail('BUILD_UNAVAILABLE', 4, 'Build attempt is unavailable in this repository.');
    return assertBuildRun(run);
  }
  async reconcile(): Promise<number> {
    // S3 calls this once under installation startup ownership, before accepting new builds.
    // It is a recovery projection, never a lease-stealing live-host job monitor.
    await this.authority('reconcile', null);
    let count = 0;
    for (const value of await this.deps.store.pending(this.deps.project_id, this.deps.repository_id)) {
      const run = assertBuildRun(value);
      if (run.project_id !== this.deps.project_id || run.repository_id !== this.deps.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 4, 'Pending attempt belongs to another repository.');
      if (!terminal.has(run.phase) && !this.active.has(run.build_id)) {
        let recovered = {};
        if (run.phase === 'exporting' && !run.realization) {
          const registration = await this.recoverRegistration(run);
          if (!registration) { await this.pendingOutcome(run); continue; }
          recovered = registration;
        }
        if (run.phase === 'checking' && !run.host_run) {
          const measurement = await this.recoverMeasurement(run);
          if (!measurement) { await this.pendingOutcome(run); continue; }
          recovered = measurement;
        }
        await this.advance(run, 'interrupted', { ...recovered, error: { code: 'BUILD_RECONCILIATION_REQUIRED', message: 'Host stopped before export/check completion. Original child outcomes were retained or reconciled; effects were not rerun.' } }); count++;
      }
    }
    return count;
  }
  async outputs(buildId: string) {
    const run = await this.inspect(buildId); await this.authority('outputs', null);
    if (!run.inventory.length || !run.verification.bytes || !['completed', 'failed'].includes(run.phase)) fail('OUTPUT_UNAVAILABLE', 8, 'This attempt has no committed verified file inventory.');
    const inventory = await this.verify(run, false);
    if (canonical(inventory) !== canonical(run.inventory)) fail('OUTPUT_TAMPERED', 6, 'Build file inventory changed.');
    return { build_id: buildId, state: run.phase, verification: run.verification, files: inventory };
  }
  async download(buildId: string, fileId: string): Promise<Buffer> {
    const inventory = await this.outputs(buildId), file = inventory.files.find(f => f.file_id === fileId);
    if (!file) fail('OUTPUT_LOCATOR_INVALID', 4, 'File is unavailable in this build.');
    await this.authority('outputs', null);
    const run = await this.inspect(buildId);
    return this.deps.output.read(run.allocation!, file);
  }
}
