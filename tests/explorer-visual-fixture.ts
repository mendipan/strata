import { Engine } from '../src/core.js';
import { MODEL, type Block } from '../src/model.js';

// Product-only synthetic intent, deliberately independent of a realization profile.
export function visualRecords(count = 8) {
  const names = ['workspace', 'records', 'search', 'review', 'history', 'access', 'storage', 'notifications'];
  const purposes = ['Help people maintain and review shared information.', 'Keep each record understandable and traceable.', 'Find relevant records using their stated intent.', 'Review proposed changes before accepting them.', 'Preserve a readable account of earlier decisions.', 'Respect the declared access boundary for each operation.', 'Retain approved records without changing their contents.', 'Tell a person when a review needs their attention.'];
  const blocks: Record<string, Block> = {};
  for (let i = 0; i < count; i++) {
    const id = names[i] ?? `module_${i}`;
    blocks[id] = { id, parent: i ? 'workspace' : null, purpose: purposes[i] ?? `Describe the intent and constraints of module ${i}.`, requirements: { behavior: { statement: i === 3 ? 'Every proposal must be reviewed before it is accepted.' : `Preserve the declared behavior of ${id}.`, kind: 'rule', facets: [i === 5 ? 'safety' : i === 6 ? 'data' : i === 2 ? 'design' : 'behavior'], acceptance: ['intent'], parameters: { enabled: true } } }, acceptance: { intent: { statement: 'A reviewer can confirm that the behavior matches the declared intent.', method: 'review', check: 'intent.review', version: '1', fixture: 'workspace-intent', subjects: [`${id}/requirements.behavior`] } }, relationships: {}, contract: { inputs: {}, outputs: {}, failures: {} } };
  }
  if (count >= 8) {
    for (const [source, target, statement] of [
      ['records', 'storage', 'Records use the retained storage contract.'],
      ['search', 'records', 'Search reads the searchable intent of records.'],
      ['review', 'records', 'Review evaluates proposed changes to records.'],
      ['records', 'review', 'Records retain the resulting review decision.'],
      ['history', 'records', 'History refers to exact retained record revisions.'],
      ['notifications', 'review', 'Notifications refer to pending review work.'],
      ['access', 'storage', 'Access constraints apply to storage operations.']
    ]) blocks[source].relationships[target] = { target, statement, acceptance: ['intent'] };
    blocks.review.acceptance.intent.subjects.push('records/purpose');
  }
  const engine = new Engine();
  engine.init({ id: 'WorkspaceBaseline', revision: 1, model_version: MODEL, root: 'workspace', blocks, authorities: { scopes: [{ block: 'workspace', selectors: ['reviewer'] }], release: ['release-reviewer'], guardians: [] }, deleted_ids: [] }, 'bootstrap');
  if (count >= 8) {
    const before = blocks.review.requirements.behavior;
    engine.layer({ id: 'L-clear-review', revision: 1, owner: 'author', model_version: MODEL, baseline: 'WorkspaceBaseline@1', intent: 'Explain review expectations before a change is accepted.', changes: [{ op: 'set_item', block: 'review', path: 'requirements.behavior', expected: { kind: 'value', value: before }, value: { ...before, statement: 'Every proposal must show its affected items and pass review before it is accepted.' } }], requires_layers: [], read_set: [], assumptions: [], acceptance: [], resolution_proposals: [], derived_from: null }, 'author');
    engine.publish('L-clear-review@1', 'author');
  }
  return engine.records;
}
