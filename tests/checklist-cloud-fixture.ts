import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BLOCK_MODEL, canonical, bytesDigest, digest } from '../src/model.js';
import { hostRunner } from '../src/auth/runner.js';
import { runNodeCommand } from '../src/commands/node.js';
import { hostCollectionFixture } from './collection-host-fixture.js';
import { prepareChecklist, type ChecklistHandoff, type ChecklistTarget } from '../src/checklist-cloud-contract.js';
import type { ChecklistProducerSnapshot } from '../scripts/checklist-cloud-prepare.js';

// Deterministic synthetic development identities and approvals only. No real author/model/cloud run.
export async function checklistCloudFixture() {
  const fixtureClock=Date.parse('2026-10-12T12:00:00Z');
  const f = await hostCollectionFixture('synthetic-cloud-bridge', true, 'contributor-collection',fixtureClock);
  const profile = 'collection-host/1';
  async function accept(target: string, slot: string) {
    const out = '.strata/' + slot;
    const materialized = await runNodeCommand(f.root, (c, i) => f.call('runner', c, i), 'materialize', { target, profile, out });
    const realization = f.engine.read(materialized.ref, 'realization');
    const request = { target, slot, profile }; f.call('runner', 'evidence.run', request);
    const measured = await hostRunner(f.root, { [slot]: out }, [profile])(f.engine, request, f.issuer.resolve(f.tokens.runner));
    const reviews = realization.oracle.criteria.filter((c: { method: string }) => c.method === 'review').map((criterion: unknown) => f.call('reviewer', 'criterion.review', { realization: materialized.ref, criterion, accepted: true, rationale: 'Deterministic synthetic bridge fixture criterion.' }).ref);
    const assembled = f.call('runner', 'evidence.assemble', { realization: materialized.ref, run_ref: measured.ref, review_refs: reviews });
    const validation = f.call('runner', 'validate', { target, realization: materialized.ref, evidence: assembled.evidence });
    const composition = f.engine.read(target, 'composition'), evaluation = f.engine.target(target);
    const shape = { format: 'approval/3', project_id: f.issuer.projectId, model_version: BLOCK_MODEL, baseline: composition.baseline,
      authority_sha256: digest(f.engine.read(composition.baseline).authorities), target: evaluation.fingerprint, evidence_digest: validation.evidence_digest,
      generation: f.engine.mediation!.generation(), expires_at: null, binding: null };
    const scope = f.call('scope-selector', 'approve', { record: { ...shape, kind: 'scope', scope: evaluation.scope } });
    const manager = f.call('release-manager', 'approve', { record: { ...shape, kind: 'release', scope: null } });
    const released = await runNodeCommand(f.root, (c, i) => f.call('release-manager', c, i), 'release', { target, validation: validation.ref, approvals: [scope.ref, manager.ref] });
    return { release: released.ref, record: f.engine.read(released.ref), target, realization: materialized.ref, output_tree: realization.output_tree,
      manifest: path.join(f.root, out, 'realization.json'), run: measured.ref, validation: validation.ref, reviews, approvals: [scope.ref, manager.ref] };
  }
  const baselineCandidate = f.call('author-a', 'compose', { record: { ...f.recipe, id: 'SyntheticBridgeBaseline', proposals: [], selected: [] } });
  const baseline = await accept(baselineCandidate.ref, 'baseline');
  f.extension.id = 'SyntheticSeven'; f.extension.baseline = baseline.release; f.extension.intent = 'Synthetic seven-entry choice.';
  f.extension.changes[0].value.statement = 'At most 7 items exist per collection instance.'; f.extension.changes[0].value.parameters.max_items = 7;
  f.audit.baseline = baseline.release; f.publish(f.extension); f.publish(f.audit);
  const four = structuredClone(f.extension); four.id = 'SyntheticFour'; four.owner = 'author-b'; four.intent = 'Synthetic four-entry alternative.';
  four.changes[0].value.statement = 'At most 4 items exist per collection instance.'; four.changes[0].value.parameters.max_items = 4; f.publish(four);
  const considered = ['SyntheticSeven@1','SyntheticFour@1','CollectionAudit@1'].sort(), selected = ['SyntheticSeven@1','CollectionAudit@1'].sort();
  const composition = { ...f.recipe, id: 'SyntheticBridgeCandidate', baseline: baseline.release, proposals: considered, selected: considered };
  const collision = f.call('author-a', 'compose', { record: composition });
  const basis = f.call('author-a', 'mediation.prepare', { target: collision.ref, case_id: 'synthetic-bridge-choice', case_revision: 1,
    expires_at: new Date(fixtureClock + 600000).toISOString(), goal: 'Synthetic whole-Layer seven and audit choice.',
    partitions: [{ id: 'seven-audit', selected, rejected: ['SyntheticFour@1'] }], supersedes: null });
  const decision = { ...f.extension, id: 'SyntheticDecision', changes: [], created_blocks: [], resolution_proposals: [basis.decision_proposals[0].payload] };
  f.call('author-a','layer.create',{record:decision}); f.call('author-a','layer.publish',{ref:'SyntheticDecision@1'});
  const packet = f.call('author-a','mediation.prepare',{basis_ref:basis.ref,decisions:[{option_id:'seven-audit',layer:'SyntheticDecision@1',proposal_index:0}]});
  const selection = f.call('scope-selector','mediation.respond',{packet_ref:packet.ref,packet_sha256:packet.packet_sha256,case_revision:1,action:'approve_selection',option_id:'seven-audit',message:'Synthetic selector response.'});
  const resolution = f.call('author-a','resolve',{record:{layer:'SyntheticDecision@1',proposal_index:0,composition:collision.ref,approvals:[selection.ref]}});
  const final = f.call('author-a','compose',{record:{...composition,revision:2,selected,resolutions:[resolution.ref]}});
  const changed = await accept(final.ref,'changed');
  const summary = { format:'popup-result/1',source_commit:'c30676138d70a765e6af6f5073d7184ccdda7ffc',synthetic_identity:true, baseline,
    changed:{...changed,mediation:{collision:collision.ref,considered,selected,rejected:['SyntheticFour@1'],basis:basis.ref,packet:packet.ref,decision:'SyntheticDecision@1',selection:selection.ref,resolution:resolution.ref,rationale:'Synthetic fixture only.'}} };
  const records = Object.fromEntries(Object.entries(f.engine.records).filter(([,r])=>r.published)) as ChecklistHandoff['records'];
  const realization = f.engine.read(changed.realization);
  const producer = { lane_id:'e'.repeat(64), summary_sha256:bytesDigest(canonical(summary)), registry_sha256:'f'.repeat(64),
    manifest_sha256:bytesDigest(await readFile(changed.manifest)) };
  const input: ChecklistHandoff = { format:'strata-checklist-cloud-handoff/1',evidence_kind:'synthetic-test-only',source_commit:summary.source_commit,
    project_id:f.issuer.projectId,release_ref:changed.release,realization_ref:changed.realization,records,record_hashes:Object.fromEntries(Object.entries(records).map(([r,d])=>[r,digest(d.data)])),
    module_sha256:bytesDigest(realization.files['collection.mjs']),output_tree:realization.output_tree,producer,
    expectations:{capacity:7,visible_audit_events:10,unicode_observer_audit_events:11} };
  const target: ChecklistTarget = { account_id:'a'.repeat(32),namespace:'default',project_id:input.project_id,repository:'strata-smoke',app_worker:'synthetic-checklist-app',workflow_worker:'synthetic-checklist-archive',workflow:'synthetic-checklist-flow',instance_id:'synthetic-instance',run_id:'synthetic-run' };
  return { f, input, target, p: prepareChecklist(input,target,digest(input),true), summary, realization };
}

// Producer-shape qualification only: published immutable bytes, no producer files or real rehearsal touched.
export async function writeSyntheticProducer(fixture: Awaited<ReturnType<typeof checklistCloudFixture>>, directory: string) {
  const { input, summary } = fixture, project = 'contributor-collection';
  // Producer uses a fixed project id. Generate the fixture with that id only through the fixture helper's explicit parameter.
  if (input.project_id !== project) throw new Error('Synthetic producer fixture must use contributor-collection project.');
  const artifacts = path.join(directory,'.strata/state/artifacts'); await mkdir(artifacts,{recursive:true}); await mkdir(path.join(directory,'receipts'),{recursive:true});
  const entries: Record<string,unknown> = {};
  for(const [ref,r] of Object.entries(input.records)){const bytes=canonical(r.data),hash=bytesDigest(bytes);entries[ref]={hash,type:r.type,published:true};await writeFile(path.join(artifacts,hash+'.json'),bytes);}
  const registry = canonical({entries,heads:{},requests:{}}); await writeFile(path.join(directory,'.strata/state/registry.json'),registry);
  const selectedDir = path.join(directory,'.strata/changed'); await mkdir(selectedDir,{recursive:true});
  const syntheticSummary = structuredClone(summary); syntheticSummary.changed.manifest=path.join(selectedDir,'realization.json');
  const manifest = await readFile(fixture.summary.changed.manifest);
  await writeFile(path.join(selectedDir,'realization.json'),manifest);
  for(const [name,bytes] of Object.entries(fixture.realization.files) as [string,string][])await writeFile(path.join(selectedDir,name),bytes);
  await writeFile(path.join(directory,'receipts/popup-result.json'),canonical(syntheticSummary));
  await writeFile(path.join(directory,'LANE.json'),canonical({lane_id:input.producer.lane_id,project_id:project,model_version:BLOCK_MODEL}));
  const m=syntheticSummary.changed.mediation,c=syntheticSummary.changed;
  const snapshot:ChecklistProducerSnapshot={lane:directory,descriptor_file:path.join(directory,'LANE.json'),state_directory:path.join(directory,'.strata/state'),summary_file:path.join(directory,'receipts/popup-result.json'),manifest_file:c.manifest,
    source_commit:syntheticSummary.source_commit,project_id:project,release_ref:c.release,baseline_ref:syntheticSummary.baseline.release,realization_ref:c.realization,target_ref:c.target,
    output_tree:c.output_tree,release_record:c.record,baseline_record:syntheticSummary.baseline.record,collision_ref:m.collision,considered:m.considered,selected:m.selected,rejected:m.rejected,resolution_ref:m.resolution,
    required_refs:[m.basis,m.packet,m.decision,m.selection,m.resolution]};
  return { snapshot, pins:{...input.producer, summary_sha256:bytesDigest(canonical(syntheticSummary)),registry_sha256:bytesDigest(registry)} };
}
