import { fail, BLOCK_MODEL } from './model.js';
import type { Diagnostic, ScenarioContext } from './profile-types.js';
import { bookingProfiles } from './profiles/booking.js';
import { bookingSelection } from './profiles/booking-selection.js';
import { hostCounterProfile } from './profiles/counter-host.js';
import { counterProfile } from './profiles/counter-fixture.js';
import { collectionProfile } from './profiles/collection.js';
import { hostCollectionProfile } from './profiles/collection-host.js';

// A finite compiled inventory, not a plugin loader or synthesis engine.
export const profiles = Object.freeze([...bookingProfiles, counterProfile, hostCounterProfile, collectionProfile, hostCollectionProfile]);
const scenarios = profiles.map(p=>p.scenario);
const selections = [bookingSelection];
export function profileFor(id: string) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) fail('UNSUPPORTED_PROFILE', 8, 'Unknown compiled realization profile.', { id });
  return profile;
}
export function evaluateScenario(context: ScenarioContext): Diagnostic[] {
  if (!context.composition.scenario.checks.length) return [{ code: 'COMPATIBILITY_UNKNOWN', message: 'Composition requires a declared supported compatibility check.' }];
  return context.composition.scenario.checks.flatMap(check => {
    if(context.snapshot.model_version===BLOCK_MODEL&&check.id==='intent-structure'&&check.version==='1')return [];
    const capability = scenarios.find(c => c.id === check.id && c.version === check.version && c.models.includes(context.snapshot.model_version));
    return capability ? capability.evaluate(context) : [{ code: 'UNKNOWN_CHECK', message: 'Required scenario checks must be supported with an exact version.', details: { check } }];
  });
}
export function defaultProfileForScenario(model: string, checks: { id: string; version: string }[]) {
  const candidates = profiles.filter(p => p.defaultForScenario && p.models.includes(model) && checks.some(c => c.id === p.scenario.id && c.version === p.scenario.version));
  if (candidates.length !== 1) fail('UNSUPPORTED_PROFILE', 8, 'No unique finite profile supports the declared scenario capabilities.');
  return candidates[0];
}
export function selectionEvaluator(id: string) {
  const evaluator = selections.find(e => e.id === id);
  if (!evaluator) fail('UNSUPPORTED_POLICY_EVALUATOR', 8, 'Unknown compiled selection evaluator.', { id });
  return evaluator;
}
