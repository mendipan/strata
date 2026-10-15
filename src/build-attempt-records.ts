import { z } from 'zod';
import { canonical, digest, fail, parse, type Records } from './model.js';
import { buildPinSchema, type BuildPin } from './build-contracts.js';
import { assertBuildRun, buildRunSchema, type BuildRun } from './build.js';
import { authReceiptSchema, hostRunSchema } from './auth/records.js';
import { exactBuildRecord } from './build-records.js';
import { inspectReleasePublication } from './build-publication.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
export const buildAttemptRevisionSchema = z.object({
  format: z.literal('strata-build-attempt-revision/1'), project_id: id, repository_id: id,
  revision: z.number().int().positive().max(64), previous: buildPinSchema.nullable(),
  writer: id, action: z.enum(['build.start', 'build.reconcile']), authentication: buildPinSchema,
  // Admission is imported by the publication reader used by build.ts itself.
  // Resolve the frozen schema lazily so every supported import order stays inert.
  run: z.lazy(() => buildRunSchema),
}).strict();
export const buildChildReceiptSchema = z.object({
  format: z.literal('strata-build-child-receipt/1'), project_id: id, repository_id: id,
  build_id: hash, actor: id, command: z.enum(['realization.register', 'evidence.run']),
  child_key: hash, input_sha256: hash, result: buildPinSchema, authentication: buildPinSchema,
}).strict();
export const BUILD_ATTEMPT_SCHEMAS = {
  'build-attempt-revision': buildAttemptRevisionSchema,
  'build-child-receipt': buildChildReceiptSchema,
};
export const attemptRecordType = (type: string): type is keyof typeof BUILD_ATTEMPT_SCHEMAS => Object.hasOwn(BUILD_ATTEMPT_SCHEMAS, type);
export const attemptRef = (type: keyof typeof BUILD_ATTEMPT_SCHEMAS, data: unknown) => type + '@' + digest(data);
export const buildChildKey = (build_id: string, step: string) => digest({ build: build_id, step });
export const buildRunnerSlot = (build_id: string, allocation: NonNullable<BuildRun['allocation']>) => 'build-' + digest({ build: build_id, allocation });
export function attemptReferences(type: string, data: any): BuildPin[] {
  if (type === 'build-child-receipt') return [data.result, data.authentication];
  if (type !== 'build-attempt-revision') return [];
  const r: BuildRun = data.run, p = r.plan;
  return [data.previous, data.authentication, p.release, p.composition, p.validation, p.contract, p.binding, p.profile,
    ...p.approvals, ...p.publication_closure, r.realization, r.host_run].filter(Boolean) as BuildPin[];
}
export function latestAttempt(records: Records, build_id: string) {
  return Object.entries(records).filter(([, r]) => r.type === 'build-attempt-revision' && r.data.run.build_id === build_id)
    .sort((a, b) => b[1].data.revision - a[1].data.revision)[0];
}
export function attemptWriteInput(run: BuildRun, previous: BuildRun | null) {
  return previous ? { build_id: run.build_id, expected_run_sha256: digest(previous), run }
    : { selection: run.plan.selection, expected_plan_sha256: run.plan_sha256 };
}
/** Admission and backup share this pure historical check. It supplies no live authority. */
export function verifyBuildAttempts(records: Records, project: string) {
  const groups = new Map<string, Array<{ ref: string; data: z.infer<typeof buildAttemptRevisionSchema> }>>();
  const children = new Map<string, z.infer<typeof buildChildReceiptSchema>>();
  const exact = (pin: BuildPin, type?: string) => {
    const data = exactBuildRecord(records, pin, type);
    const typeName = records[pin.ref].type;
    if (attemptRecordType(typeName) && pin.ref !== attemptRef(typeName, data)) fail('BUILD_RUN_CORRUPT', 6, 'Attempt reference differs from its immutable bytes.');
    return data;
  };
  const authentication = (pin: BuildPin, actor: string, action: string, input_sha256: string) => {
    const auth = parse(authReceiptSchema, exact(pin, 'auth-receipt'));
    if (pin.ref !== 'auth-receipt@' + digest(auth) || auth.project_id !== project || auth.principal_id !== actor || auth.action !== action || auth.input_sha256 !== input_sha256)
      fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Attempt authentication differs from its exact action, actor or input.');
    return auth;
  };
  for (const [ref, stored] of Object.entries(records)) {
    if (!attemptRecordType(stored.type)) continue;
    const d: any = parse(BUILD_ATTEMPT_SCHEMAS[stored.type] as z.ZodType<any>, stored.data);
    if (!stored.published || d.project_id !== project || ref !== attemptRef(stored.type, d)) fail('BUILD_RUN_CORRUPT', 6, 'Attempt history identity or project differs.');
    for (const pin of attemptReferences(stored.type, d)) exact(pin);
    if (stored.type === 'build-child-receipt') {
      authentication(d.authentication, d.actor, d.command, d.input_sha256);
      if (d.child_key !== buildChildKey(d.build_id, d.command)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Child receipt has a foreign deterministic key.');
      const key = canonical([d.project_id, d.repository_id, d.actor, d.child_key]);
      if (children.has(key)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Child action has competing receipts.');
      children.set(key, d); continue;
    }
    const run = assertBuildRun(d.run);
    if (run.project_id !== d.project_id || run.repository_id !== d.repository_id) fail('BUILD_REPOSITORY_MISMATCH', 6, 'Attempt envelope crosses a repository.');
    const previous = d.previous ? parse(buildAttemptRevisionSchema, exact(d.previous, 'build-attempt-revision')) : null;
    if (previous) {
      const p = previous.run;
      if (p.build_id !== run.build_id || previous.revision + 1 !== d.revision ||
        canonical({ ...run, events: p.events, phase: p.phase, allocation: p.allocation, realization: p.realization, output_tree: p.output_tree, host_run: p.host_run, inventory: p.inventory, verification: p.verification, error: p.error }) !== canonical(p) ||
        run.events.length < p.events.length || run.events.length > p.events.length + 1 || canonical(run.events.slice(0, p.events.length)) !== canonical(p.events) ||
        p.allocation && canonical(p.allocation) !== canonical(run.allocation) || p.realization && canonical(p.realization) !== canonical(run.realization) || p.host_run && canonical(p.host_run) !== canonical(run.host_run) ||
        ['completed', 'failed', 'interrupted', 'output_incomplete'].includes(p.phase))
        fail('BUILD_RUN_CONFLICT', 6, 'Attempt revision rewrites identity, prior events or committed pins.');
    } else if (d.revision !== 1 || run.phase !== 'accepted' || run.events.length !== 1 || run.allocation || run.realization || run.host_run || run.inventory.length || run.error || d.action !== 'build.start' || d.writer !== run.actor)
      fail('BUILD_RUN_CORRUPT', 6, 'Attempt must start with an authenticated uneffected accepted record.');
    if (d.action === 'build.start' && d.writer !== run.actor) fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Only the original actor can advance a running build.');
    const writeInput = attemptWriteInput(run, previous?.run ?? null);
    const writeAuth = authentication(d.authentication, d.writer, d.action, digest(writeInput));
    if (writeAuth.request_sha256 !== digest({ command: d.action, input: writeInput, principal: d.writer, policy: writeAuth.policy_generation })) fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Attempt request authentication is inconsistent.');
    const p = run.plan, profile = exact(p.profile, 'build-profile'), binding = exact(p.binding, 'release-build-binding');
    if (profile.project_id !== project || profile.repository_id !== run.repository_id || profile.contract_ref !== p.contract.ref || profile.contract_sha256 !== p.contract.sha256 ||
      canonical(profile.materializer) !== canonical(p.materializer) || canonical(binding.release) !== canonical(p.release) || canonical(binding.contract) !== canonical(p.contract) || binding.repository_id !== run.repository_id)
      fail('BUILD_PIN_MISMATCH', 6, 'Attempt lost its exact saved profile or adoption binding.');
    const publication = inspectReleasePublication({ project_id: project, records, source_trust: p.source_trust }, p.release.ref);
    if (!publication.historically_approved || canonical(publication.composition) !== canonical(p.composition) || canonical(publication.validation) !== canonical(p.validation) ||
      canonical(publication.approvals) !== canonical(p.approvals) || canonical(publication.closure) !== canonical(p.publication_closure)) fail('BUILD_PUBLICATION_CORRUPT', 6, 'Attempt plan differs from exact historical publication closure.');
    if (run.realization) {
      const r = exact(run.realization, 'realization');
      if (r.target !== p.release.ref || r.candidate !== p.candidate || r.profile_id !== p.materializer.id || r.profile !== p.materializer.archive_sha256 || r.output_tree !== run.output_tree)
        fail('BUILD_PIN_MISMATCH', 6, 'Attempt realization differs from its plan.');
    }
    if (run.host_run) {
      const h = parse(hostRunSchema, exact(run.host_run, 'host-run')), r = run.realization && exact(run.realization, 'realization');
      if (!r || h.realization !== run.realization!.ref || h.producer !== run.actor || h.profile_id !== r.profile_id ||
        ['candidate', 'profile', 'output_tree', 'checker_sha256', 'fixture_sha256', 'oracle_sha256'].some(k => (h as any)[k] !== r[k]) ||
        run.verification.mechanical !== h.results.every(result => result.passed)) fail('BUILD_RUN_RECEIPT_MISMATCH', 6, 'Attempt measurement differs from its exact realization/producer.');
      const expected = [...new Map(r.coverage.flatMap((c: any) => c.checks.filter((k: any) => k.method === 'mechanical').map((k: any) => [canonical({ check: k.check, version: k.version, fixture: k.fixture }), { check: k.check, version: k.version, fixture: k.fixture }]))).values()];
      if (!expected.length || canonical(expected.map(canonical).sort()) !== canonical(h.results.map(({ passed, ...key }) => canonical(key)).sort())) fail('BUILD_RUN_RECEIPT_MISMATCH', 6, 'Attempt measurement lacks exact mechanical coverage.');
    }
    const list = groups.get(run.build_id) ?? []; list.push({ ref, data: d }); groups.set(run.build_id, list);
  }
  const requests = new Set<string>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.data.revision - b.data.revision);
    if (list.some((v, i) => v.data.revision !== i + 1 || i > 0 && v.data.previous?.ref !== list[i - 1].ref)) fail('BUILD_RUN_CONFLICT', 6, 'Attempt history is forked or incomplete.');
    const run = list.at(-1)!.data.run, key = canonical([run.project_id, run.repository_id, run.actor, run.request_key]);
    if (requests.has(key)) fail('BUILD_REQUEST_CONFLICT', 6, 'Original request key has competing attempts.'); requests.add(key);
  }
  for (const child of children.values()) {
    const accepted = groups.get(child.build_id)?.[0].data.run;
    if (!accepted || accepted.actor !== child.actor || accepted.repository_id !== child.repository_id) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Child receipt lacks its original accepted attempt.');
    const result = exact(child.result, child.command === 'evidence.run' ? 'host-run' : 'realization');
    const latest = groups.get(child.build_id)!.at(-1)!.data.run;
    const expected = child.command === 'realization.register' ? { record: result }
      : { target: accepted.plan.release.ref, profile: accepted.plan.materializer.id, slot: latest.allocation && buildRunnerSlot(child.build_id, latest.allocation) };
    if (child.input_sha256 !== digest(expected)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Child receipt does not bind exact registration or allocated runner input.');
    const auth = authentication(child.authentication, child.actor, child.command, digest(expected));
    if (auth.request_sha256 !== digest({ command: child.command, input: expected, principal: child.actor, policy: auth.policy_generation })) fail('BUILD_AUTH_CLOSURE_INVALID', 6, 'Original child request authentication is inconsistent.');
    if (child.command === 'evidence.run' && (!latest.allocation || result.auth_receipt !== child.authentication.ref || result.producer !== child.actor)) fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Runner receipt lacks original actor and output-slot authentication.');
  }
  for (const list of groups.values()) for (const { data: { run } } of list) {
    for (const [command, pin] of [['realization.register', run.realization], ['evidence.run', run.host_run]] as const) {
      if (pin && ![...children.values()].some(c => c.build_id === run.build_id && c.actor === run.actor && c.repository_id === run.repository_id && c.command === command && canonical(c.result) === canonical(pin)))
        fail('BUILD_CHILD_RECEIPT_MISMATCH', 6, 'Attempt result has no exact original child receipt.');
    }
  }
}
