import { MODEL, type Snapshot, type Layer, type Composition } from '../model.js';
import { EXPECTED_PURPOSES, EXCLUSIVE, expiryRequirement, timingRequirement, CONTRACTS } from './booking.js';
export const criterion = (check: string, fixture: string, subjects: string[], method: 'mechanical' | 'review' = 'mechanical') => ({ statement: `Verify ${check} for ${fixture}.`, method, check, version: '1', fixture, subjects });
export function bootstrap(): Snapshot {
  const blocks: Snapshot['blocks'] = {};
  for (const [id, purpose] of Object.entries(EXPECTED_PURPOSES)) blocks[id] = { id, parent: id === 'app' ? null : id === 'booking' ? 'app' : 'booking', purpose, requirements: {}, acceptance: { review: criterion('intent.review', id, [id + '/purpose'], 'review') }, relationships: {}, contract: { inputs: {}, outputs: {}, failures: {} } };
  const hold = blocks['booking.hold'], reminder = blocks['booking.reminder'];
  hold.requirements = { expiry: expiryRequirement(600), exclusive: structuredClone(EXCLUSIVE) };
  hold.acceptance.expiry = criterion('booking.expiry', 'expiry', ['booking.hold/requirements.expiry', 'booking.hold/contract.outputs.state']);
  hold.acceptance.exclusive = criterion('booking.exclusive', 'exclusive', ['booking.hold/requirements.exclusive', 'booking.hold/contract.inputs.hold', 'booking.hold/contract.failures.occupied']);
  hold.acceptance.lifecycle = criterion('booking.lifecycle', 'lifecycle', ['booking.hold/requirements.expiry']);
  hold.contract.inputs.hold = { statement: CONTRACTS['booking.hold/contract.inputs.hold'], acceptance: ['exclusive'] };
  hold.contract.outputs.state = { statement: CONTRACTS['booking.hold/contract.outputs.state'], acceptance: ['expiry'] };
  hold.contract.failures.occupied = { statement: CONTRACTS['booking.hold/contract.failures.occupied'], acceptance: ['exclusive'] };
  reminder.requirements.timing = timingRequirement(false);
  reminder.acceptance.timing = criterion('booking.reminder', 'timing', ['booking.reminder/requirements.timing', 'booking.reminder/relationships.hold']);
  reminder.acceptance.once = criterion('booking.once', 'once', ['booking.reminder/requirements.timing']);
  reminder.relationships.hold = { statement: CONTRACTS['booking.reminder/relationships.hold'], target: 'booking.hold', acceptance: ['timing'] };
  return { id: 'R0', revision: 1, model_version: MODEL, root: 'app', blocks, authorities: { scopes: [{ block: 'app', selectors: ['scope-selector'] }, { block: 'booking', selectors: ['scope-selector'] }, { block: 'booking.hold', selectors: ['scope-selector'] }, { block: 'booking.reminder', selectors: ['scope-selector'] }], release: ['release-manager'], guardians: [{ item: 'booking.hold/requirements.exclusive', principal: 'safety-guardian' }] }, deleted_ids: ['deleted-demo'] };
}
export function proposal(id: string, owner: string, changes: Layer['changes'] = []): Layer {
  return { id, revision: 1, owner, model_version: MODEL, baseline: 'R0@1', intent: id, changes, requires_layers: [], read_set: [], assumptions: [], acceptance: [], resolution_proposals: [], derived_from: null };
}
export function demoLayers() {
  const a = proposal('L-hold', 'author-a', [{ op: 'set_item', block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(600) }, value: expiryRequirement(900) }]);
  const b = proposal('L-reminder', 'author-b', [{ op: 'set_item', block: 'booking.reminder', path: 'requirements.timing', expected: { kind: 'value', value: timingRequirement(false) }, value: timingRequirement(true) }]);
  b.requires_layers = ['L-hold@1']; b.read_set = [{ layer: 'L-hold@1', mode: 'required' }]; b.assumptions = [{ block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(900) } }];
  b.acceptance = [{ block: 'booking.reminder', id: 'layer-reminder', criterion: criterion('booking.reminder', 'layer-reminder', ['booking.reminder/requirements.timing']) }];
  const c = proposal('L-alternative', 'author-c', [{ op: 'set_item', block: 'booking.hold', path: 'requirements.expiry', expected: { kind: 'value', value: expiryRequirement(600) }, value: expiryRequirement(1200) }]);
  return { a, b, c };
}
export function recipe(id = 'C-demo', baseline = 'R0@1'): Composition {
  return { id, revision: 1, model_version: MODEL, baseline, proposals: ['L-hold@1', 'L-reminder@1', 'L-alternative@1'], selected: ['L-hold@1', 'L-reminder@1', 'L-alternative@1'], alternative_groups: [{ id: 'duration', members: ['L-hold@1', 'L-alternative@1'], min: 1, max: 1 }], scenario: { id: 'booking-demo', checks: [{ id: 'booking.compatibility', version: '1' }] }, resolutions: [] };
}
