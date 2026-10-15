import { Engine } from './core.js';
import { BLOCK_MODEL, canonical, digest, fail, type Records } from './model.js';
import { type AuthorityIssuer, type SecurityContext } from './security.js';
import type { Registry } from './local-broker.js';
import { executeAuthorized } from './service.js';
import { buildRepositoryView } from './build-repository-view.js';
import { assertRepositoryReceipt } from './repository-receipts.js';
import { PROFILE_MUTATIONS, PROFILE_OPERATIONS, buildRecordRef } from './build-records.js';
import { BuildProfileService, type ProfileServiceScope } from './profile-service.js';
import { LocalBuildCoordinator, assertBuildRun, type BuildAttemptStore, type BuildRun, type RegistrationLookup, type RegistrationOutcome, type MeasurementLookup, type MeasurementOutcome } from './build.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION, LOCAL_BUILD_OPERATIONS, parseLocalBuildOperation } from './build-operations.js';
import { attemptRef, latestAttempt, buildChildKey, buildRunnerSlot, attemptWriteInput, verifyBuildAttempts, attemptRecordType, attemptReferences } from './build-attempt-records.js';
import { runLocalBuildChecks } from './build-node.js';
import { currentBuildHost, type HostEnvironment } from './build-host.js';
import { LocalBuildOutput } from './build-output.js';
import { normalizeRepositoryContract, type BuildPin } from './build-contracts.js';
import { profileFor } from './profiles.js';
import { describeBuildOptions } from './build-options.js';
import { preflightLocalHost } from './build-host.js';
import { inspectReleasePublication } from './build-publication.js';

import type { RepositoryTransaction } from './local-broker.js';
export type LocalBuildOptions = { key?: string; expected_generation?: string; expected_policy?: string; dry_run?: boolean };
export type BuildRepositoryConfig = {
  issuer: AuthorityIssuer; scope: ProfileServiceScope; output: LocalBuildOutput;
  host?: () => Promise<HostEnvironment>; refreshAuthority?: () => void;
  transaction: RepositoryTransaction; close?: () => Promise<void>;
};
const terminal = ['completed', 'failed', 'interrupted', 'output_incomplete'];
/** Shared coordinator services. Persistence is supplied by the sole host writer. */
export function createBuildRepository(config: BuildRepositoryConfig) {
  const { issuer, scope, output } = config;
  let closed = false, closing = false, recovering = false;
  let closePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const transaction = <T>(context: SecurityContext, command: string, input: unknown,
    work: (engine: Engine, registry: Registry) => Promise<{ data:T; write?:boolean; receipt?:{key:string;digest:string;result:any} }>, write = false, internalKey?: string,
    replayAuthorize?: (engine: Engine, registry: Registry, data: unknown) => void | Promise<void>) =>
    config.transaction(context, command, input, { dry_run: !write, key: internalKey,
      replay_authorize: async (engine: Engine, registry: Registry, data: unknown) => {
        authorize(context, command, input, engine);
        await replayAuthorize?.(engine, registry, data);
      } }, async (engine, registry) => {
      authorize(context, command, input, engine);
      return work(engine, registry);
    });
  function authorize(context: SecurityContext, command: string, input: unknown, engine?: Engine) {
    config.refreshAuthority?.();
    if (context.trust_mode !== 'host_authenticated') fail('AUTHENTICATION_REQUIRED', 4, 'Local build dispatch requires an authenticated host actor.');
    issuer.authorize(context, command, input, engine);
    if (PROFILE_OPERATIONS.includes(command as any) || BUILD_OPERATIONS.includes(command as any) || command === BUILD_RECOVERY_OPERATION)
      issuer.assertRepository(context, command, scope.repository_id, []);
  }
  function service(engine: Engine, context: SecurityContext) {
    return new BuildProfileService(engine, { ...scope, review: scope.review ?? ((action, subject) => {
      const reviews = Object.entries(engine.records).filter(([, r]) => r.type === 'build-contract-review' && r.data.project_id === scope.project_id && r.data.repository_id === scope.repository_id && r.data.action === action && r.data.subject_sha256 === subject);
      if (!reviews.length) return undefined;
      const [ref, r] = reviews.sort(([a], [b]) => a.localeCompare(b))[0]; return { ref, sha256: digest(r.data) };
    }) }, context, issuer);
  }
  function view(engine:Engine,context:SecurityContext) {return buildRepositoryView(engine,scope,context);}
  function bindAuth(engine: Engine, context: SecurityContext, command: string, input: unknown): BuildPin {
    issuer.assertLive(context);
    engine.authentication = { receipt: { format: 'strata-host-auth/1', project_id: context.project_id, model_version: BLOCK_MODEL,
      principal_id: context.principal_id, principal_kind: context.principal_kind, account_id: context.account_id, credential_epoch: context.credential_epoch,
      action: command, input_sha256: digest(input), request_sha256: digest({ command, input, principal: context.principal_id, policy: context.policy_version }),
      policy_generation: context.policy_version, grant_id: context.grant_id, expires_at: context.expires_at, trust: 'host-authenticated' }, assertLive: () => issuer.assertLive(context) };
    const ref = engine.authReceipt(command); return { ref, sha256: digest(engine.read(ref, 'auth-receipt')) };
  }
  function runtimeAuthority(context: SecurityContext) {
    for (const command of ['materialize', 'realization.register', 'evidence.run', 'inspect', 'build.inspect', 'build.outputs'])
      authorize(context, command, ['materialize', 'evidence.run'].includes(command) ? { profile: 'collection-host/1' } : {});
  }
  function expected(engine: Engine, context: SecurityContext, options: LocalBuildOptions) {
    if (options.expected_policy !== undefined && options.expected_policy !== context.policy_version) fail('STALE_POLICY', 5, 'Assigned policy changed before dispatch.');
    if (options.expected_generation !== undefined && options.expected_generation !== digest(view(engine, context))) fail('STALE_GENERATION', 5, 'Saved project view changed before dispatch.');
  }
  function runFor(engine: Engine, build_id: string): BuildRun | null {
    const row = latestAttempt(engine.records, build_id);
    if (!row || row[1].data.repository_id !== scope.repository_id || row[1].data.project_id !== scope.project_id) return null;
    const run = assertBuildRun(row[1].data.run);
    if (scope.visible && [run.plan.profile, run.plan.binding, ...run.plan.publication_closure].some(p => !scope.visible!(p.ref))) fail('BUILD_UNAVAILABLE', 4, 'Build source closure is unavailable in this read scope.');
    return run;
  }
  function runs(engine: Engine) {
    const ids = [...new Set(Object.values(engine.records).filter(r => r.type === 'build-attempt-revision' && r.data.repository_id === scope.repository_id).map(r => r.data.run.build_id as string))];
    return ids.map(id => runFor(engine, id)).filter((r): r is BuildRun => !!r);
  }
  function dependencies(context: SecurityContext, recoveringNow = false) {
    const read = <T>(action: string, input: unknown, f: (engine: Engine, registry: Registry) => T | Promise<T>) => transaction<T>(context, action, input, async (e, r) => ({ data: await f(e, r) }));
    const action = recoveringNow ? BUILD_RECOVERY_OPERATION : 'build.start';
    const store: BuildAttemptStore = {
      request: (p, r, a, key) => read('build.inspect', {}, e => p === scope.project_id && r === scope.repository_id ? runs(e).find(run => run.actor === a && run.request_key === key) ?? null : null),
      get: id => read('build.inspect', { build_id: id }, e => runFor(e, id)),
      pending: (p, r) => read(recoveringNow ? action : 'build.inspect', {}, e => p === scope.project_id && r === scope.repository_id ? runs(e).filter(run => !terminal.includes(run.phase)) : []),
      accept: async run => {
        let executed = false;
        const accepted = await transaction<{ created: boolean; run: BuildRun }>(context, action, attemptWriteInput(run, null), async (engine, registry) => {
        executed = true;
        assertBuildRun(run); if (recoveringNow || run.actor !== context.principal_id || run.repository_id !== scope.repository_id) fail('BUILD_AUTHORITY_CHANGED', 4, 'Attempt admission must use its original authenticated actor.');
        const prior = runs(engine).find(r => r.actor === run.actor && r.request_key === run.request_key);
        if (prior) { if (prior.request_sha256 !== run.request_sha256) fail('BUILD_REQUEST_CONFLICT', 5, 'Original request key binds another payload.'); return { data: { created: false, run: prior } }; }
        const requestKey = `${context.tenant_id}:${context.project_id}:${context.principal_id}:${run.request_key}`;
        const requestDigest = digest({ command: 'build.start', input: attemptWriteInput(run, null), principal: context.principal_id });
        if (registry.requests[requestKey] && registry.requests[requestKey].digest !== requestDigest) fail('IDEMPOTENCY_CONFLICT', 5, 'Original request key belongs to another repository operation.');
        const data = { format: 'strata-build-attempt-revision/1', project_id: scope.project_id, repository_id: scope.repository_id, revision: 1, previous: null,
          writer: context.principal_id, action, authentication: bindAuth(engine, context, action, attemptWriteInput(run, null)), run };
        engine.store(attemptRef('build-attempt-revision', data), 'build-attempt-revision', data);
        return { data: { created: true, run }, write: true, receipt: { key: requestKey, digest: requestDigest, result: { ok: true, data: run, created: [attemptRef('build-attempt-revision', data)], operation_id: run.build_id, dry_run: false } } };
        }, true, run.request_key);
        if (executed) return accepted;
        // A cached acceptance is the original snapshot, while the attempt may have advanced.
        // Only the first admission may own output work, including concurrent exact requests.
        const retained = await read('build.inspect', { build_id: run.build_id }, engine => runFor(engine, run.build_id));
        if (!retained || retained.actor !== run.actor || retained.request_sha256 !== run.request_sha256)
          fail('BUILD_REQUEST_CONFLICT', 6, 'Acceptance replay lost its exact retained attempt.');
        return { created: false, run: retained };
      },
      replace: async (run, sha) => { await transaction(context, action, { build_id: run.build_id, expected_run_sha256: sha, run }, async (engine, registry) => {
        const prior = runFor(engine, run.build_id), row = latestAttempt(engine.records, run.build_id);
        if (!prior || !row || digest(prior) !== sha) fail('BUILD_RUN_CONFLICT', 5, 'Full attempt changed before transition commit.');
        const data = { format: 'strata-build-attempt-revision/1', project_id: scope.project_id, repository_id: scope.repository_id, revision: row[1].data.revision + 1,
          previous: { ref: row[0], sha256: digest(row[1].data) }, writer: context.principal_id, action,
          authentication: bindAuth(engine, context, action, attemptWriteInput(run, prior)), run };
        const ref = attemptRef('build-attempt-revision', data); engine.store(ref, 'build-attempt-revision', data);
        const key = `${context.tenant_id}:${context.project_id}:${run.actor}:${run.request_key}`, cached = registry.requests[key];
        if (!cached || cached.digest !== digest({ command: 'build.start', input: attemptWriteInput(run, null), principal: run.actor })) fail('BUILD_REQUEST_CONFLICT', 6, 'Attempt lost its original request receipt.');
        return { data: undefined, write: true, receipt: { key, digest: cached.digest, result: { ...cached.result, data: run, created: [...cached.result.created, ref] } } };
      }, true); },
    };
    const child = async (command: string, input: any, key: string, check?: Parameters<typeof runLocalBuildChecks>[3]) => {
      if (!['materialize', 'realization.register', 'inspect', 'evidence.run'].includes(command)) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown private build child action.');
      return transaction(context, command, input, async (engine, registry) => {
        authorize(context, recoveringNow ? BUILD_RECOVERY_OPERATION : command === 'inspect' ? 'build.inspect' : 'build.start', {}, engine);
        const step = command === 'inspect' ? 'inspect-' + input.type : command;
        const run = runs(engine).find(r => buildChildKey(r.build_id, step) === key);
        if (!run) fail('BUILD_CHILD_RECEIPT_MISMATCH', 4, 'Private child key has no visible original attempt.');
        if (command !== 'inspect' && (recoveringNow || run.actor !== context.principal_id || terminal.includes(run.phase))) fail('BUILD_AUTHORITY_CHANGED', 4, 'Private child action requires its original live build actor.');
        if (command === 'inspect') {
          if (!['realization', 'host-run'].includes(input.type)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 4, 'Build inspection only reads retained child results.');
          const pins = [run.realization, run.host_run, ...Object.values(engine.records).filter(r => r.type === 'build-child-receipt' && r.data.build_id === run.build_id && r.data.repository_id === scope.repository_id).map(r => r.data.result)];
          if (!pins.some(p => p?.ref === input.ref)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 4, 'Inspection is outside the original build child closure.');
          return { data: executeAuthorized(engine, command, input, context, issuer) };
        }
        if (command === 'materialize') {
          if (canonical(input) !== canonical({ target: run.plan.release.ref, profile: run.plan.materializer.id })) fail('BUILD_CHILD_RECEIPT_MISMATCH', 4, 'Materialization differs from the accepted selection.');
          return { data: executeAuthorized(engine, command, input, context, issuer) };
        }
        const receiptKey = canonical([context.tenant_id, scope.project_id, scope.repository_id, run.actor, key]);
        const prior = Object.values(engine.records).find(r => r.type === 'build-child-receipt' && r.data.build_id === run.build_id && r.data.repository_id === scope.repository_id && r.data.actor === run.actor && r.data.child_key === key);
        if (prior) {
          if (prior.data.command !== command || prior.data.input_sha256 !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 5, 'Original child key binds another input.');
          const result = engine.read(prior.data.result.ref);
          return { data: command === 'realization.register' ? { ref: prior.data.result.ref, reused: true } : { ref: prior.data.result.ref, run: result, checks_passed: result.results.every((r: any) => r.passed) } };
        }
        let result: any;
        if (command === 'realization.register') {
          if (canonical(input.record) !== canonical(engine.realize(run.plan.release.ref, run.plan.materializer.id))) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Registration differs from exact accepted output.');
          result = executeAuthorized(engine, command, input, context, issuer);
        } else {
          if (!check || !run.allocation || canonical(check.allocation) !== canonical(run.allocation) || check.build_id !== run.build_id || run.phase !== 'checking' ||
            canonical(input) !== canonical({ target: run.plan.release.ref, profile: run.plan.materializer.id, slot: buildRunnerSlot(run.build_id, run.allocation) })) fail('OUTPUT_LOCATOR_INVALID', 4, 'Finite checks require the exact original build allocation.');
          executeAuthorized(engine, 'evidence.run', input, context, issuer);
          result = await runLocalBuildChecks(output, engine, context, check);
          authorize(context, 'evidence.run', input, engine);
        }
        const authentication = { ref: engine.authReceipt(command), sha256: digest(engine.read(engine.authReceipt(command), 'auth-receipt')) };
        const data = { format: 'strata-build-child-receipt/1', project_id: scope.project_id, repository_id: scope.repository_id,
          build_id: run.build_id, actor: run.actor, command, child_key: key, input_sha256: digest(input),
          result: { ref: result.ref, sha256: digest(engine.read(result.ref)) }, authentication };
        engine.store(attemptRef('build-child-receipt', data), 'build-child-receipt', data);
        const response = { ok: true, data: result, created: [], operation_id: key, dry_run: false };
        return { data: result, write: true, receipt: { key: receiptKey, digest: digest({ command, input, principal: run.actor, repository_id: scope.repository_id }), result: response } };
      }, !['inspect','materialize'].includes(command), undefined, engine => {
        authorize(context, recoveringNow ? BUILD_RECOVERY_OPERATION : command === 'inspect' ? 'build.inspect' : 'build.start', {}, engine);
        verifyBuildAttempts(engine.records, scope.project_id);
        const step = command === 'inspect' ? 'inspect-' + input.type : command;
        const run = runs(engine).find(r => buildChildKey(r.build_id, step) === key);
        if (!run || command !== 'inspect' && (recoveringNow || run.actor !== context.principal_id))
          fail('BUILD_AUTHORITY_CHANGED', 4, 'Child replay requires the original visible attempt and current build authority.');
      });
    };
    const lookupRegistration = async (input: RegistrationLookup): Promise<RegistrationOutcome> => read(BUILD_RECOVERY_OPERATION, {}, (engine) => {
      const run = runFor(engine, input.build_id);
      if (!run || input.project_id !== scope.project_id || input.repository_id !== scope.repository_id || input.actor !== run.actor || input.command !== 'realization.register' || input.child_key !== buildChildKey(run.build_id, input.command)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 4, 'Original receipt lookup is outside its accepted scope.');
      verifyBuildAttempts(engine.records, scope.project_id);
      const receipt = Object.values(engine.records).find(r => r.type === 'build-child-receipt' && r.data.project_id === input.project_id && r.data.repository_id === input.repository_id && r.data.actor === input.actor && r.data.build_id === input.build_id && r.data.command === input.command && r.data.child_key === input.child_key);
      return receipt ? { state: 'committed', command: 'realization.register', child_key: receipt.data.child_key, input_sha256: receipt.data.input_sha256, ref: receipt.data.result.ref } : { state: 'unknown' };
    });
    const lookupMeasurement=async(input:MeasurementLookup):Promise<MeasurementOutcome>=>read(BUILD_RECOVERY_OPERATION,{},engine=>{
      const run=runFor(engine,input.build_id);
      if(!run||input.project_id!==scope.project_id||input.repository_id!==scope.repository_id||input.actor!==run.actor||input.command!=='evidence.run'||input.child_key!==buildChildKey(run.build_id,input.command))fail('BUILD_CHILD_RECEIPT_MISMATCH',4,'Measurement lookup is outside the original accepted scope.');
      verifyBuildAttempts(engine.records,scope.project_id);
      const receipt=Object.values(engine.records).find(r=>r.type==='build-child-receipt'&&r.data.repository_id===scope.repository_id&&r.data.actor===run.actor&&r.data.build_id===run.build_id&&r.data.command===input.command&&r.data.child_key===input.child_key);
      return receipt?{state:'committed',command:'evidence.run',child_key:receipt.data.child_key,input_sha256:receipt.data.input_sha256,ref:receipt.data.result.ref}:{state:'unknown'};
    });
    return {
      project_id: scope.project_id, repository_id: scope.repository_id, store, output,
      lookup: { compatibility: (ref?: string) => read('repository.compatibility', ref ? { release_ref: ref } : {}, engine => service(engine, context).execute('repository.compatibility', ref ? { release_ref: ref } : {})),
        profile: (ref: string) => read('profile.inspect', { ref }, engine => service(engine, context).profile(ref)) },
      readContext: () => read(recoveringNow ? BUILD_RECOVERY_OPERATION : 'build.prepare', {}, engine => ({ engine,
        source_generation: Object.values(engine.records).filter(r => !['auth-receipt', 'realization', 'host-run', 'build-attempt-revision', 'build-child-receipt'].includes(r.type)).length,
        publication: { project_id: scope.project_id, records: engine.records, asset_bytes: engine.options.assetBytes, source_trust: scope.source_trust, visible: scope.visible } })),
      authorize: async (step: string, plan: any) => {
        const operation = ({ prepare: 'build.prepare', start: 'build.start', materialize: 'materialize', register: 'realization.register', check: 'evidence.run', outputs: 'build.outputs', inspect: 'build.inspect', reconcile: BUILD_RECOVERY_OPERATION } as Record<string, string>)[step];
        authorize(context, operation, plan ? { target: plan.release.ref, profile: plan.materializer.id } : {});
        if (step === 'prepare' || step === 'start') runtimeAuthority(context);
        if (['materialize', 'realization.register', 'evidence.run'].includes(operation)) authorize(context, 'build.start', {});
        return { actor: context.principal_id, project_id: scope.project_id, repository_id: scope.repository_id, policy_sha256: digest(context.policy_version) };
      },
      host: config.host ?? (async () => currentBuildHost('Studio host', null)), operation: child, lookupRegistration, lookupMeasurement,
      runChecks: (input: Parameters<typeof runLocalBuildChecks>[3] & { child_key: string }) => child('evidence.run', { target: input.target, profile: input.profile, slot: buildRunnerSlot(input.build_id, input.allocation) }, input.child_key, input),
    };
  }
  const dispatch = async (command: string, input: unknown, context: SecurityContext, options: LocalBuildOptions = {}) => {
    const parsed = parseLocalBuildOperation(command, input);
    if (parsed === null) fail('UNSUPPORTED_CAPABILITY', 8, 'Operation is unavailable on the Local Profiles/Build adapter.');
    authorize(context, command, parsed);
    if (['operation.inspect', 'studio.snapshot', 'capabilities'].includes(command)) return transaction(context, command, parsed, async (engine, registry) => {
      authorize(context, context.allowed_operations.includes('profile.list') ? 'profile.list' : 'build.inspect', {}, engine);
      const generation = digest(view(engine, context));
      let data: any;
      if (command === 'operation.inspect') {
        const receipt = registry.requests[`${context.tenant_id}:${context.project_id}:${context.principal_id}:${parsed.key}`];
        if (receipt) assertRepositoryReceipt(receipt, context, engine, issuer, scope);
        const r = receipt?.result.data;
        if (r?.repository_id && r.repository_id !== scope.repository_id || r?.record?.repository_id && r.record.repository_id !== scope.repository_id) fail('BUILD_UNAVAILABLE', 4, 'Request outcome is unavailable in this repository.');
        data = receipt ? { key: parsed.key, state: 'committed', result: receipt.result } : { key: parsed.key, state: 'not_found', result: null };
      } else if (command === 'studio.snapshot') data = { records: view(engine, context), generation, principal_id: context.principal_id, policy_generation: context.policy_version, trust: scope.source_trust };
      else data = { model_version: BLOCK_MODEL, generation, policy_generation: context.policy_version, output_slots: [output.slot.id],
        operations: LOCAL_BUILD_OPERATIONS.map(operation => { let allowed = true; try { authorize(context, operation, {}); if (['build.prepare', 'build.start'].includes(operation)) runtimeAuthority(context); } catch { allowed = false; }
          return { operation, configured: true, allowed, supported: true }; }), run_application: false, serve_application: false };
      return { data: { ok: true, data, created: [], operation_id: null } };
    });
    const coordinator = new LocalBuildCoordinator(dependencies(context));
    if (PROFILE_OPERATIONS.includes(command as any)) {
      let replayed = false;
      return transaction(context, command, parsed, async (engine, registry) => {
      const profileService = service(engine, context), mutation = PROFILE_MUTATIONS.includes(command as any);
      if (mutation && !options.key) fail('IDEMPOTENCY_REQUIRED', 2, 'Profile writes require their original request key.');
      const key = `${context.tenant_id}:${context.project_id}:${context.principal_id}:${options.key}`, request = digest({ command, input: parsed, principal: context.principal_id });
      if (mutation && !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key!)) fail('IDEMPOTENCY_REQUIRED', 2, 'Profile writes require an exact bounded request key.');
      const cached = mutation && registry.requests[key];
      if (cached) { if (cached.digest !== request) fail('IDEMPOTENCY_CONFLICT', 5, 'Original request key binds another payload.'); profileService.assertVisibleRecord(cached.result.data.ref); return { data: { ...cached.result, reused: true } }; }
      expected(engine, context, options); const before = new Set(Object.keys(engine.records));
      const data = profileService.execute(command, parsed);
      const response = { ok: true, data, created: options.dry_run ? [] : Object.keys(engine.records).filter(ref => !before.has(ref)), operation_id: request.slice(0, 24), dry_run: !!options.dry_run };
      return { data: response, write: mutation && !options.dry_run, ...(mutation && !options.dry_run ? { receipt: { key, digest: request, result: response } } : {}) };
      }, PROFILE_MUTATIONS.includes(command as any) && !options.dry_run,
        'profile-step-'+digest({command,input:parsed,principal:context.principal_id,key:options.key??null}),
        (engine, _registry, cached) => {
          replayed = true;
          const profiles = service(engine, context); profiles.assertAuthority(command, parsed);
          profiles.assertVisibleRecord((cached as any).data.ref);
        }).then(result => replayed ? { ...result, reused: true, created: [] } : result);
    }
    await transaction(context, command, parsed, async (engine, registry) => {
      const cacheKey = `${context.tenant_id}:${context.project_id}:${context.principal_id}:${options.key}`, cached = command === 'build.start' && options.key && registry.requests[cacheKey];
      if (cached) {
        if (cached.digest !== digest({ command, input: parsed, principal: context.principal_id })) fail('IDEMPOTENCY_CONFLICT', 5, 'Original request key binds another payload.');
      } else expected(engine, context, options);
      return { data: undefined };
    });
    let data: any;
    if (command === 'build.prepare') data = await coordinator.prepare(parsed);
    else if (command === 'build.start') {
      if (recovering) fail('STATE_BUSY', 5, 'Installation startup reconciliation is active.');
      if (!options.key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key)) fail('IDEMPOTENCY_REQUIRED', 2, 'Build needs an exact bounded original request key.');
      data = options.dry_run ? { execution_ready: false, ...(await coordinator.prepare((parsed as any).selection)) } : await coordinator.start(parsed, options.key);
    } else if (command === 'build.inspect') data = await coordinator.inspect((parsed as any).build_id);
    else if (command === 'build.outputs') data = await coordinator.outputs((parsed as any).build_id);
    else data = await transaction(context, command, parsed, async engine => {
      const refs = Object.entries(engine.records).filter(([ref, r]) => r.type === 'release' && (!parsed.release_ref || parsed.release_ref === ref) && (!scope.visible || scope.visible(ref))).map(([ref]) => ref).sort();
      if (parsed.cursor && !refs.includes(parsed.cursor)) fail('INVALID_CURSOR', 2, 'Build context cursor is outside the current visible selection.');
      const offset = parsed.cursor ? refs.indexOf(parsed.cursor) + 1 : 0, page = refs.slice(offset, offset + (parsed.limit ?? 100));
      const releases = page.map(ref => ({ ref, publication: inspectReleasePublication({ project_id: scope.project_id, records: engine.records, asset_bytes: engine.options.assetBytes, source_trust: scope.source_trust, visible: scope.visible }, ref) }));
      const host = await preflightLocalHost(await (config.host ?? (async () => currentBuildHost('Studio host', null)))(), output, describeBuildOptions(profileFor('collection-host/1')).requirements);
      return { data: { format: 'strata-local-build-context/1', project_id: scope.project_id, repository_id: scope.repository_id,
        releases: releases.filter(r => r.publication.historically_approved).map(r => r.publication), excluded: releases.filter(r => r.publication.state !== 'unavailable' && !r.publication.historically_approved).map(r => ({ ref: r.ref, code: r.publication.code, message: r.publication.message })),
        cursor: offset + page.length < refs.length ? page.at(-1) : null, profiles: service(engine, context).execute('profile.list', {}).profiles,
        destinations: [{ kind: 'local', host }, { kind: 'cloudflare-worker', supported: false, code: 'WORKER_BUILD_UNSUPPORTED' }], run_application: false, serve_application: false } };
    });
    return { ok: true, data, created: [], operation_id: data?.build_id ?? null, dry_run: !!options.dry_run };
  };
  function external<T>(work: () => Promise<T>, startupRecovery = false): Promise<T> {
    if (closing || closed) return Promise.reject(new Error('Local build registry is closing or closed.'));
    if (recovering && !startupRecovery) return Promise.reject(new Error('Local build registry is reconciling under startup ownership.'));
    const task = work(); active.add(task); void task.finally(() => active.delete(task)).catch(() => {}); return task;
  }
  return {
    // Read-only identity of the already admitted host scope, for Studio drafts.
    repository_id: scope.repository_id,
    snapshot(context: SecurityContext) {
      return external(() => transaction(context, 'studio.snapshot', {}, async engine => {
        authorize(context, context.allowed_operations.includes('profile.list') ? 'profile.list' : 'build.inspect', {}, engine);
        return { data: { generation: digest(view(engine, context)), policy_generation: context.policy_version } };
      }));
    },
    execute(command: string, input: unknown, context: SecurityContext, options?: LocalBuildOptions) {
      return external(() => dispatch(command, input, context, options));
    },
    // Called once by a stopped/starting installation owner before exposing routes.
    async reconcile(context: SecurityContext) {
      if (closing || closed || recovering || active.size) fail('STATE_BUSY', 5, 'Reconciliation requires exclusive startup ownership before requests.');
      recovering = true;
      try { return await external(() => new LocalBuildCoordinator(dependencies(context, true)).reconcile(), true); } finally { recovering = false; }
    },
    download(build_id: string, file_id: string, context: SecurityContext) {
      return external(async () => { const bytes = await new LocalBuildCoordinator(dependencies(context)).download(build_id, file_id);
        authorize(context, 'build.outputs', { build_id }); return bytes; });
    },
    // Existing repository review authority, retained atomically. No public review route.
    review(command: 'repository.contract.import' | 'repository.contract.attach', input: unknown, context: SecurityContext, options: LocalBuildOptions) {
      let replayed = false;
      return external(() => transaction(context, command, input, async (engine, registry) => {
        if (!options.key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key)) fail('IDEMPOTENCY_REQUIRED', 2, 'Internal repository review needs an exact original key.');
        const key = `${context.tenant_id}:${context.project_id}:${context.principal_id}:${options.key}`, request = digest({ command, input, principal: context.principal_id, internal_review: true });
        if (registry.requests[key]) { if (registry.requests[key].digest !== request) fail('IDEMPOTENCY_CONFLICT', 5, 'Review key binds another subject.'); if (!issuer.permitsApproval(context, 'release')) fail('AUTHORITY_FORBIDDEN', 4, 'Review replay requires current review authority.'); return { data: registry.requests[key].result }; }
        expected(engine, context, options); const data = service(engine, context).review(command, input);
        const result = { ok: true, data, created: [data.ref], operation_id: request.slice(0, 24), dry_run: false };
        return { data: result, write: true, receipt: { key, digest: request, result } };
      }, true, 'review-'+digest({command,input,principal:context.principal_id,key:options.key??null}), (engine, _registry, cached) => {
        replayed = true;
        const profileService = service(engine, context);
        profileService.assertAuthority(command, input);
        if (!issuer.permitsApproval(context, 'release')) fail('AUTHORITY_FORBIDDEN', 4, 'Review replay requires current review authority.');
        const ref = (cached as any)?.data?.ref;
        if (typeof ref !== 'string') fail('BUILD_REVIEW_INVALID', 6, 'Review replay lost its exact retained review.');
        profileService.assertVisibleRecord(ref);
        const review = engine.read(ref, 'build-contract-review');
        const normalized = parseLocalBuildOperation(command, input);
        if (command === 'repository.contract.import') normalized.record = normalizeRepositoryContract(normalized.record);
        if (review.reviewer !== context.principal_id || review.action !== command || review.subject_sha256 !== digest(normalized) ||
          (cached as any).data.sha256 !== digest(review) || !engine.read(review.authority.ref, 'release').authorities.release.includes(context.principal_id))
          fail('BUILD_REVIEW_INVALID', 6, 'Review replay differs from its original authorized subject.');
      }).then(result => replayed ? { ...result, reused: true, created: [] } : result));
    },
    close() {
      if (!closePromise) { closing = true; closePromise = (async () => { await Promise.allSettled([...active]); closed = true; await config.close?.(); })(); }
      return closePromise;
    },
  };
}
