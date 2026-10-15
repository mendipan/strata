import { Engine } from '../src/core.js';
import { bootstrap, demoLayers, proposal, recipe } from '../src/fixtures.js';
import { type Evidence } from '../src/model.js';
export function prepared() {
  const engine = new Engine(); engine.init(bootstrap(), 'bootstrap');
  const { a, b, c } = demoLayers();
  for (const layer of [a, b, c]) { const draft = engine.layer(layer, layer.owner); engine.publish(draft.ref, layer.owner); }
  const blocked = engine.compose(recipe()); const decision = proposal('L-decision', 'scope-selector');
  decision.resolution_proposals = [{ input_fingerprint: blocked.input_fingerprint, impact: blocked.impact, scope: blocked.scope, outcome: { kind: 'select', selected: ['L-hold@1', 'L-reminder@1'], rejected: ['L-alternative@1'] } }];
  const draft = engine.layer(decision, decision.owner); engine.publish(draft.ref, decision.owner);
  const request = { layer: draft.ref, proposal_index: 0, composition: blocked.ref, approvals: [] as string[] };
  const unsigned = engine.resolution(request, 'scope-selector', true) as any;
  const endorsement = engine.approve({ kind: 'resolution', target: unsigned.target, scope: unsigned.scope, evidence_digest: null }, 'scope-selector'); request.approvals.push(endorsement.ref);
  const resolution = engine.resolution(request, 'scope-selector') as any;
  const selected = recipe(); selected.revision = 2; selected.selected = ['L-hold@1', 'L-reminder@1']; selected.resolutions = [resolution.ref];
  const candidate = engine.compose(selected);
  return { engine, blocked, candidate, resolution, request, unsigned, a, b, c };
}
export function unitValidation(engine: Engine, candidate: ReturnType<Engine['compose']>) {
  const realization = engine.realize(candidate.ref, 'booking-node/1'); const registration = engine.registerRealization(realization);
  const criteria = Object.values(candidate.snapshot.blocks).flatMap(b => Object.values(b.acceptance));
  const evidence: Evidence = { candidate: candidate.fingerprint, profile: realization.profile, output_tree: realization.output_tree, executor: 'strata-local-fixture-runner/1', results: criteria.map(c => ({ check: c.check, version: c.version, fixture: c.fixture, method: c.method, passed: true, reviewer: c.method === 'review' ? 'fixture-reviewer' : null })) };
  const validation = engine.validate(candidate.ref, registration.ref, evidence);
  return { realization, registration, evidence, validation };
}
export function approvals(engine: Engine, candidate: ReturnType<Engine['compose']>, evidenceDigest: string) {
  return [engine.approve({ kind: 'scope', target: candidate.fingerprint, scope: candidate.scope, evidence_digest: evidenceDigest }, 'scope-selector').ref, engine.approve({ kind: 'release', target: candidate.fingerprint, scope: null, evidence_digest: evidenceDigest }, 'release-manager').ref];
}
