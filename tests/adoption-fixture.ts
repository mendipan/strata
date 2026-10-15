import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesDigest, digest, type Snapshot, type Layer } from '../src/model.js';
import { obligations } from '../src/core.js';
import { type SourceSnapshot } from '../src/source-binding.js';
import { ADOPTION_KINDS, type AdoptionInventory, type AdoptionUnit } from '../src/adoption/contract.js';

export async function adoptionFixture() {
  const baseline: Snapshot = JSON.parse(await readFile('tests/fixtures/counter/bootstrap.json', 'utf8'));
  const layer: Layer = JSON.parse(await readFile('tests/fixtures/counter/extend.json', 'utf8'));
  const paths = ['protected.bin', 'protected.txt', 'selected.mjs', 'selected.test.mjs'];
  const entries: SourceSnapshot['entries'] = await Promise.all(paths.map(async name => {
    const bytes = await readFile(path.join('tests/fixtures/adoption', name));
    return { path: name, presence: 'present' as const, kind: 'regular' as const, mode: '100644' as const, byte_length: bytes.length, sha256: bytesDigest(bytes) };
  }));
  const selectedItems = obligations(baseline);
  const scope: SourceSnapshot['scope'] = {
    format: 'source-scope/1', coverage: 'selected-scope', paths, watch_roots: [],
    exclusions: [], items: selectedItems.map(o => o.item).sort(),
    mapping: selectedItems.map(o => ({ item: o.item, paths: ['selected.mjs'], criteria: [...o.criteria].sort() })).sort((a,b) => a.item.localeCompare(b.item)),
    limitations: ['Source capture only; protected files do not create accepted semantic bindings.']
  };
  const source: SourceSnapshot = {
    format: 'source-snapshot/1', project_id: 'adoption-synthetic', repo_id: 'synthetic-repository',
    object_format: 'sha1', head_commit: 'a'.repeat(40), head_tree: 'b'.repeat(40),
    scope, scope_sha256: digest(scope), entries, manifest_sha256: digest(entries)
  };
  const unit = (id: string, kind: AdoptionUnit['kind'], items: string[], sourcePath = 'selected.mjs'): AdoptionUnit => ({
    id, kind, description: 'Declared ' + kind + ' interpretation for selected positive additions.',
    scope: 'adopted', classification: kind === 'state' ? 'inferred' : 'observed',
    rationale: 'Prepared source interpretation; no behavior or evidence was executed.',
    disposition: 'mapped', files: [{ path: sourcePath, sha256: entries.find(entry => entry.path === sourcePath)!.sha256! }],
    dependency_paths: sourcePath === 'selected.test.mjs' ? ['selected.mjs'] : [],
    items: [...items].sort(), criteria: [...new Set(items.flatMap(item => selectedItems.find(o => o.item === item)!.criteria))].sort(), evidence_refs: []
  });
  const units = [
    unit('add', 'behavior', ['counter/purpose', 'counter/requirements.limit']),
    unit('errors', 'error', ['counter/requirements.integers', 'counter/contract.failures.ceiling']),
    unit('interface', 'interface', ['counter/contract.inputs.add', 'counter/contract.outputs.total']),
    unit('state', 'state', ['counter/requirements.limit']),
    unit('tests', 'test', ['counter/acceptance.add', 'counter/acceptance.invalid', 'counter/acceptance.limit'], 'selected.test.mjs'),
    {
      ...unit('unadopted-report', 'behavior', []), scope: 'outside' as const, disposition: 'excluded' as const,
      description: 'The unrelated report is outside selected adoption.',
      files: entries.filter(entry => entry.path.startsWith('protected.')).map(entry => ({ path: entry.path, sha256: entry.sha256! }))
    }
  ];
  const inventory: AdoptionInventory = {
    format: 'adoption-inventory/1', project_id: source.project_id, source: { ref: 'source-snapshot@' + digest(source), sha256: digest(source) },
    mode: 'incremental', declared_scope: 'Selected positive addition behavior; unrelated report remains unadopted.',
    units,
    accounting: ADOPTION_KINDS.map(kind => ({ kind, unit_ids: units.filter(unit => unit.kind === kind).map(unit => unit.id).sort(), none_reason: null })),
    protected_paths: ['protected.bin', 'protected.txt'],
    exclusions: [{ unit_id: 'unadopted-report', reason: 'Preserve the original report files and behavior outside this adoption.' }],
    questions: [], limitations: ['Declared inventory only; independent behavior, publication and freshness are not established.']
  };
  return { inventory, source, baseline_ref: 'CounterBaseline@1', baseline, layer };
}
