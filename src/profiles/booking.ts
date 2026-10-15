import { CONTENT_MODEL, MODEL, digest, bytesDigest, canonical, fail, type Snapshot } from '../model.js';
import {checkerArchive,checkerDigest,fixtureOracle,fixtureDigest} from './booking-checker.js';
import type { Evaluation } from '../core.js';
import { treeDigest, type Coverage, type Realization, type ProfileAdapter, type ScenarioCapability } from '../profile-types.js';
import { bookingFixtureChecker } from './booking-runner.js';

export const PROFILE = { id: 'booking-node/1', template_version: '1', capabilities: ['exclusive-resource-hold', 'integer-expiry', 'single-reminder', 'command-line'], checks: ['booking.exclusive', 'booking.expiry', 'booking.reminder', 'booking.once', 'booking.lifecycle', 'intent.review'], trust: 'bounded-local-fixture' };
export const CONTENT_PROFILE = {...PROFILE,id:'booking-node/2',template_version:'2',capabilities:[...PROFILE.capabilities,'background-retention-manifest']};
export const BOUND_PROFILE={...PROFILE,id:'booking-node/3',template_version:'3',capabilities:[...PROFILE.capabilities,'exact-obligation-check-edges','independent-oracle','checker-bound-evidence']};
export const BOUND_CONTENT_PROFILE={...BOUND_PROFILE,id:'booking-node/4',template_version:'4',capabilities:[...BOUND_PROFILE.capabilities,'background-retention-manifest']};
export const PROFILE_IDS=[PROFILE.id,CONTENT_PROFILE.id,BOUND_PROFILE.id,BOUND_CONTENT_PROFILE.id];
export const boundProfile=(id:string)=>[BOUND_PROFILE.id,BOUND_CONTENT_PROFILE.id].includes(id);
export const profileArchive=(id=PROFILE.id)=>({...({[PROFILE.id]:PROFILE,[CONTENT_PROFILE.id]:CONTENT_PROFILE,[BOUND_PROFILE.id]:BOUND_PROFILE,[BOUND_CONTENT_PROFILE.id]:BOUND_CONTENT_PROFILE}[id]),template:PROGRAM,...(boundProfile(id)?{checker:checkerArchive()}: {})});
export const profileFingerprint=(id=PROFILE.id)=>digest(profileArchive(id));
export const EXPECTED_PURPOSES: Record<string, string> = {
  app: 'A command-driven booking demonstration.',
  booking: 'Coordinate exclusive holds and reminders.',
  'booking.hold': 'Hold one resource until a fixed expiry.',
  'booking.reminder': 'Remind a holder once shortly before expiry.'
};
export function expiryRequirement(seconds: number) { return { statement: `A hold expires exactly ${seconds} seconds after it starts.`, kind: 'rule' as const, facets: ['behavior', 'data'] as ('behavior' | 'data')[], acceptance: ['expiry'], parameters: { seconds } }; }
export function timingRequirement(enabled: boolean, lead = 60) { return { statement: enabled ? `Send one reminder ${lead} seconds before hold expiry.` : 'Reminders are disabled.', kind: 'rule' as const, facets: ['behavior'] as 'behavior'[], acceptance: ['timing', 'once'], parameters: { enabled, lead_seconds: lead } }; }
export const EXCLUSIVE = { statement: 'Only one active hold may exist for a resource.', kind: 'invariant' as const, facets: ['behavior', 'data', 'safety'] as ('behavior' | 'data' | 'safety')[], acceptance: ['exclusive'], parameters: { exclusive: true } };
export const CONTRACTS: Record<string, string> = {
  'booking.hold/contract.inputs.hold': 'A hold request identifies one resource and one owner.',
  'booking.hold/contract.outputs.state': 'State exposes active holds and their expiry.',
  'booking.hold/contract.failures.occupied': 'An occupied resource rejects another hold.',
  'booking.reminder/relationships.hold': 'Reminder timing consumes the hold duration.'
};
function knownRequirement(key: string, value: any): boolean {
  if (key === 'booking.hold/requirements.expiry') {
    const seconds = value.parameters.seconds;
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86400) return false;
    return value.statement === expiryRequirement(seconds).statement && value.kind === 'rule' && canonical(value.parameters) === canonical({ seconds });
  }
  if (key === 'booking.hold/requirements.exclusive') return value.statement === EXCLUSIVE.statement && value.kind === 'invariant' && canonical(value.parameters) === canonical(EXCLUSIVE.parameters);
  if (key === 'booking.reminder/requirements.timing') {
    const { enabled, lead_seconds } = value.parameters;
    return typeof enabled === 'boolean' && Number.isInteger(lead_seconds) && lead_seconds >= 0 && value.statement === timingRequirement(enabled, lead_seconds).statement && value.kind === 'rule' && canonical(value.parameters) === canonical({ enabled, lead_seconds });
  }
  return false;
}
export function materialize(target: string, evaluation: Evaluation, profileId=evaluation.snapshot.model_version===CONTENT_MODEL ? CONTENT_PROFILE.id : PROFILE.id): Realization {
  const snapshot = evaluation.snapshot; const unsupported: string[] = [];
  if (Object.keys(snapshot.blocks).sort().join('|') !== Object.keys(EXPECTED_PURPOSES).sort().join('|')) unsupported.push('snapshot/block-set');
  const expectedItems=Object.fromEntries(evaluation.obligations.map(o=>[o.item,o.value]));
  const criteria = new Map<string, Snapshot['blocks'][string]['acceptance'][string]>(Object.values(snapshot.blocks).flatMap(b => Object.entries(b.acceptance).map(([k, c]) => [`${b.id}/acceptance.${k}`, c] as const)));
  for (const [reference, criterion] of criteria) {
    const allowedSubjects: Record<string, string[]> = {
      'booking.exclusive': ['booking.hold/requirements.exclusive', 'booking.hold/contract.inputs.hold', 'booking.hold/contract.failures.occupied'],
      'booking.expiry': ['booking.hold/requirements.expiry', 'booking.hold/contract.outputs.state'],
      'booking.lifecycle': ['booking.hold/requirements.expiry'],
      'booking.reminder': ['booking.reminder/requirements.timing', 'booking.reminder/relationships.hold'],
      'booking.once': ['booking.reminder/requirements.timing'],
      'intent.review': [reference.split('/')[0] + '/purpose']
    };
    if (criterion.statement !== `Verify ${criterion.check} for ${criterion.fixture}.` || criterion.subjects.some(s => !allowedSubjects[criterion.check]?.includes(s))) unsupported.push(reference + ':unrecognized-claim');
  }
  for (const obligation of evaluation.obligations) {
    if (obligation.facets.includes('design')) unsupported.push(obligation.item + ':design');
    if (obligation.item.includes('/requirements.') && !knownRequirement(obligation.item, obligation.value)) unsupported.push(obligation.item);
    if (obligation.item.endsWith('/purpose') && obligation.value !== EXPECTED_PURPOSES[obligation.item.split('/')[0]]) unsupported.push(obligation.item);
    if (obligation.item.includes('/contract.') || obligation.item.includes('/relationships.')) if (obligation.value.statement !== CONTRACTS[obligation.item]) unsupported.push(obligation.item);
    if (obligation.criteria.length === 0) unsupported.push(obligation.item + ':unmapped');
    for (const reference of obligation.criteria) {
      const criterion = criteria.get(reference);
      if (!criterion || !PROFILE.checks.includes(criterion.check) || criterion.version !== '1' || criterion.method !== (criterion.check === 'intent.review' ? 'review' : 'mechanical')) unsupported.push(reference + ':unsupported-check');
    }
  }
  const requiredChecks:Record<string,string[]>={
    'booking.hold/requirements.exclusive':['booking.exclusive'],
    'booking.hold/contract.inputs.hold':['booking.exclusive'],
    'booking.hold/contract.failures.occupied':['booking.exclusive'],
    'booking.hold/requirements.expiry':['booking.expiry'],
    'booking.hold/contract.outputs.state':['booking.expiry'],
    'booking.reminder/requirements.timing':['booking.reminder','booking.once'],
    'booking.reminder/relationships.hold':['booking.reminder']
  };
  const invalidEdges:string[]=[];
  for(const obligation of evaluation.obligations) {
    if(obligation.item.includes('/acceptance.')) continue;
    const linked=obligation.criteria.map(ref=>criteria.get(ref));
    for(const criterion of linked) if(criterion && !criterion.subjects.includes(obligation.item)) invalidEdges.push(obligation.item+':unrelated-subject');
    for(const required of requiredChecks[obligation.item] ?? (obligation.item.endsWith('/purpose')?['intent.review']:[])) if(!linked.some(c=>c?.check===required && c.subjects.includes(obligation.item))) invalidEdges.push(obligation.item+':missing-'+required);
  }
  if (unsupported.length) fail('UNSUPPORTED_OBLIGATION', 8, 'The bounded booking profile cannot completely realize these active obligations.', { unsupported: [...new Set(unsupported)].sort() });
  if(invalidEdges.length) fail('OBLIGATION_CHECK_MISMATCH',8,'Linked criteria must actually cover their booking obligation and required check family.',{invalid_edges:[...new Set(invalidEdges)].sort()});
  for(const required of Object.keys(requiredChecks)) if(!Object.hasOwn(expectedItems,required)) fail('OBLIGATION_CONSERVATION',5,'The bounded booking profile requires its complete core obligation set.',{missing:required});
  const config = { seconds: snapshot.blocks['booking.hold'].requirements.expiry.parameters.seconds, enabled: snapshot.blocks['booking.reminder'].requirements.timing.parameters.enabled, lead_seconds: snapshot.blocks['booking.reminder'].requirements.timing.parameters.lead_seconds };
  const files: Record<string, string> = { 'booking.mjs': PROGRAM.replace('__CONFIG__', JSON.stringify(config)), 'intent.json': canonical(config) + '\n', 'README.md': 'Disposable local booking realization. Run node booking.mjs hold resource owner --state-file /path/to/runtime.json, then advance seconds or state. Keep runtime state outside this output tree.\n' };
  const asset_manifest=Object.fromEntries(Object.values(snapshot.blocks).filter(b=>Object.keys(b.asset_refs ?? {}).length).map(b=>[b.id,b.asset_refs]));
  if(snapshot.model_version===CONTENT_MODEL) files['assets.json']=canonical({format:'background-retention/1',asset_manifest,executable_resources:[]})+'\n';
  const outputs = Object.entries(files).map(([path, body]) => ({ path, digest: bytesDigest(body) }));
  const coverage: Coverage[] = evaluation.obligations.map(obligation => ({ item: obligation.item, facets: obligation.facets, subjects: obligation.item.includes('/acceptance.') ? obligation.value.subjects : [obligation.item], status: 'implemented_validation_pending', capability: obligation.item.endsWith('/purpose') ? 'command-line-and-explicit-review' : 'bounded-booking-template', rationale: 'The pinned booking template implements this recognized item; imported fixture evidence and explicit review remain required.', outputs, checks: obligation.criteria.map(r => { const c = criteria.get(r)!; return { check: c.check, version: c.version, fixture: c.fixture, method: c.method }; }), facet_handling: Object.fromEntries(obligation.facets.map(f => [f, f === 'safety' ? 'Exclusive-hold check verifies the recognized safety invariant; facet does not grant authority.' : 'The same bounded state-machine outputs and referenced checks cover this facet.'])) }));
  return { protocol_version: '1', model_version: snapshot.model_version, target, candidate: evaluation.fingerprint, profile_id:profileId,profile:profileFingerprint(profileId),...(boundProfile(profileId)?{format:'strata-realization/2' as const,checker_sha256:checkerDigest(),oracle:fixtureOracle(snapshot),oracle_sha256:digest(fixtureOracle(snapshot)),fixture_sha256:fixtureDigest(fixtureOracle(snapshot))}: {}), ...(snapshot.model_version===CONTENT_MODEL ? {asset_manifest,asset_closure_sha256:digest(asset_manifest)} : {}), files, output_tree: treeDigest(files), coverage, reverse_links: Object.fromEntries(Object.keys(files).map(path => [path, coverage.map(c => c.item)])), trust: 'local-template' };
}
export const bookingScenario: ScenarioCapability = {
  id: 'booking.compatibility', version: '1', models: [MODEL, CONTENT_MODEL],
  evaluate({ snapshot, composition, proposals }) {
    const diagnostics: ReturnType<ScenarioCapability['evaluate']> = [];
    const add = (code: string, message: string) => diagnostics.push({ code, message });
    // This conservative domain rule was formerly embedded in Engine.evaluate.
    const reminder = snapshot.blocks['booking.reminder']?.requirements.timing;
    if (reminder?.parameters.enabled === true) {
      const duration = snapshot.blocks['booking.hold']?.requirements.expiry?.parameters.seconds;
      if (typeof duration !== 'number' || typeof reminder.parameters.lead_seconds !== 'number' || reminder.parameters.lead_seconds >= duration || reminder.parameters.lead_seconds < 0) add('SEMANTIC_INCOMPATIBILITY', 'Reminder must occur strictly before hold expiry.');
      const enabling = composition.selected.filter(r => proposals.get(r)!.changes.some(c => c.block === 'booking.reminder' && c.path === 'requirements.timing'));
      if (enabling.some(r => !proposals.get(r)!.assumptions.some(a => a.block === 'booking.hold' && a.path === 'requirements.expiry'))) add('COMPATIBILITY_UNKNOWN', 'A reminder edit must declare its final duration assumption.');
    }
    return diagnostics;
  }
};
export function describeBookingEffects(snapshot: Snapshot) {
  const hold=snapshot.blocks['booking.hold']?.requirements,reminder=snapshot.blocks['booking.reminder']?.requirements.timing.parameters;
  return 'Intended expiry: '+hold?.expiry.parameters.seconds+' seconds. Reminder: '+(reminder?.enabled?'once at '+((hold?.expiry.parameters.seconds as number)-(reminder.lead_seconds as number))+' seconds':'disabled')+'. Exclusivity: '+hold?.exclusive.parameters.exclusive+'. All declared acceptance still requires fresh evidence; effects outside this fixture are unknown.';
}
export const bookingProfiles: ProfileAdapter[] = PROFILE_IDS.map(id => ({
  id, models: [id === CONTENT_PROFILE.id || id === BOUND_CONTENT_PROFILE.id ? CONTENT_MODEL : MODEL],
  scenario: bookingScenario, defaultForScenario: id === PROFILE.id || id === CONTENT_PROFILE.id,
  boundEvidence: boundProfile(id), archive: () => profileArchive(id),
  materialize: (target, evaluation) => materialize(target, evaluation, id),
  checker: bookingFixtureChecker, describeEffects: describeBookingEffects
}));
// This template is code owned by the profile, never code or commands imported from evidence.
const PROGRAM = `import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const config = __CONFIG__;
export function createBooking(initial = { now: 0, holds: {}, reminders: [] }) {
  const state = structuredClone(initial);
  function advance(seconds) {
    if (!Number.isInteger(seconds) || seconds < 0) throw new Error('advance requires nonnegative integer seconds');
    state.now += seconds;
    for (const hold of Object.values(state.holds)) {
      if (config.enabled && !hold.reminded && state.now >= hold.expires - config.lead_seconds && state.now < hold.expires) { hold.reminded = true; state.reminders.push({ resource: hold.resource, owner: hold.owner, at: state.now }); }
      if (state.now >= hold.expires) delete state.holds[hold.resource];
    }
    return structuredClone(state);
  }
  function hold(resource, owner) {
    if (typeof resource !== 'string' || !resource || typeof owner !== 'string' || !owner || ['__proto__', 'constructor', 'prototype'].includes(resource)) throw new Error('invalid hold request');
    if (Object.hasOwn(state.holds, resource)) return { accepted: false, reason: 'occupied' };
    state.holds[resource] = { resource, owner, expires: state.now + config.seconds, reminded: false };
    return { accepted: true, expires: state.now + config.seconds };
  }
  return { hold, advance, state: () => structuredClone(state) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2); const index = args.indexOf('--state-file');
    if (index < 0 || !args[index + 1]) throw new Error('--state-file is required outside the realization output tree');
    const file = args[index + 1]; args.splice(index, 2);
    let initial; try { initial = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const app = createBooking(initial); let result;
    if (args[0] === 'hold' && args.length === 3) result = app.hold(args[1], args[2]);
    else if (args[0] === 'advance' && args.length === 2) result = app.advance(Number(args[1]));
    else if (args[0] === 'state' && args.length === 1) result = app.state();
    else throw new Error('use hold resource owner, advance seconds, or state');
    writeFileSync(file, JSON.stringify(app.state()) + '\\n');
    process.stdout.write(JSON.stringify(result) + '\\n');
  } catch (e) { process.stderr.write(e.message + '\\n'); process.exitCode = 2; }
}
`;
