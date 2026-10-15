import { z } from 'zod';
import { canonical, digest, fail, parse } from '../model.js';
import { SOURCE_LIMITS, sourceHashSchema, sourcePath, sourceRefSchema, sourceTextSchema, validateSourceSnapshot, type SourceSnapshot } from '../source-binding.js';

export const ADOPTION_KINDS = ['behavior', 'interface', 'error', 'state', 'test'] as const;
export const ADOPTION_LIMITS = { units: 256, questions: 256, record_bytes: 1024 * 1024 } as const;
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/).max(120);
const text = sourceTextSchema.refine(value => value.trim().length > 0, 'Blank text is unsupported.');
const path = z.string().refine(value => { try { sourcePath(value); return true; } catch { return false; } }, 'Unsafe source path.');
const semanticItem = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/(?:purpose|requirements\.[A-Za-z0-9_.-]+|acceptance\.[A-Za-z0-9_.-]+|relationships\.[A-Za-z0-9_.-]+|contract\.(?:inputs|outputs|failures)\.[A-Za-z0-9_.-]+)$/).max(512);
const criterion = semanticItem.refine(value => value.split('/')[1].startsWith('acceptance.'), 'An acceptance item reference is required.');
const itemSet = z.array(semanticItem).max(SOURCE_LIMITS.entries);
const unitIds = z.array(id).max(ADOPTION_LIMITS.units);
export const adoptionSourcePinSchema = z.object({
  ref: z.string().regex(/^source-snapshot@[a-f0-9]{64}$/), sha256: sourceHashSchema
}).strict();
export const adoptionUnitSchema = z.object({
  id, kind: z.enum(ADOPTION_KINDS), description: text,
  scope: z.enum(['adopted', 'outside']), classification: z.enum(['observed', 'inferred']), rationale: text,
  disposition: z.enum(['mapped', 'excluded', 'unknown']),
  files: z.array(z.object({ path, sha256: sourceHashSchema }).strict()).min(1).max(SOURCE_LIMITS.entries),
  dependency_paths: z.array(path).max(SOURCE_LIMITS.entries),
  items: itemSet, criteria: z.array(criterion).max(SOURCE_LIMITS.entries),
  evidence_refs: z.array(sourceRefSchema).max(SOURCE_LIMITS.entries)
}).strict();
export const adoptionInventorySchema = z.object({
  format: z.literal('adoption-inventory/1'), project_id: id, source: adoptionSourcePinSchema,
  mode: z.enum(['incremental', 'reconstruct_declared_scope']), declared_scope: text,
  units: z.array(adoptionUnitSchema).min(1).max(ADOPTION_LIMITS.units),
  accounting: z.array(z.object({ kind: z.enum(ADOPTION_KINDS), unit_ids: unitIds, none_reason: text.nullable() }).strict()).length(ADOPTION_KINDS.length),
  protected_paths: z.array(path).max(SOURCE_LIMITS.entries),
  exclusions: z.array(z.object({ unit_id: id, reason: text }).strict()).max(ADOPTION_LIMITS.units),
  questions: z.array(z.object({ id, unit_ids: unitIds, text }).strict()).max(ADOPTION_LIMITS.questions),
  limitations: z.array(text).max(256)
}).strict();
export const adoptionProposalSchema = z.object({
  format: z.literal('adoption-proposal/1'), project_id: id,
  inventory_ref: z.string().regex(/^adoption-inventory@[a-f0-9]{64}$/), inventory_sha256: sourceHashSchema,
  source: adoptionSourcePinSchema, baseline_ref: sourceRefSchema, baseline_snapshot_sha256: sourceHashSchema,
  layer_ref: sourceRefSchema, layer_sha256: sourceHashSchema, model_version: text, author: text,
  output_lane: z.enum(['selected_git_patch', 'independent_reconstruction'])
}).strict();
export type AdoptionInventory = z.infer<typeof adoptionInventorySchema>;
export type AdoptionUnit = z.infer<typeof adoptionUnitSchema>;
export type AdoptionProposal = z.infer<typeof adoptionProposalSchema>;

export function sortedSet(values: string[], label: string, paths = false): string[] {
  const identities = values.map(value => paths ? value.toLowerCase() : value);
  if (new Set(identities).size !== values.length) fail('INVALID_RECORD', 2, label + ' contains duplicate or aliased identities.');
  if (paths && identities.some((value, index) => identities.some((other, j) => index !== j && other.startsWith(value + '/')))) {
    fail('INVALID_PATH', 2, label + ' contains a file/directory prefix collision.');
  }
  return [...values].sort();
}
export function boundedRecord(value: unknown): void {
  if (new TextEncoder().encode(canonical(value)).length > ADOPTION_LIMITS.record_bytes) fail('SOURCE_LIMIT', 8, 'Adoption record exceeds its serialized byte budget.');
}
export function adoptionInventoryRef(inventory: AdoptionInventory): string { return 'adoption-inventory@' + digest(inventory); }
export function adoptionProposalRef(proposal: AdoptionProposal): string { return 'adoption-proposal@' + digest(proposal); }

export function normalizeAdoptionInventory(input: unknown): AdoptionInventory {
  const inventory = parse(adoptionInventorySchema, input);
  boundedRecord(inventory);
  sortedSet(inventory.units.map(unit => unit.id), 'Unit IDs');
  sortedSet(inventory.accounting.map(section => section.kind), 'Accounting kinds');
  sortedSet(inventory.exclusions.map(exclusion => exclusion.unit_id), 'Excluded unit IDs');
  sortedSet(inventory.questions.map(question => question.id), 'Question IDs');
  inventory.protected_paths = sortedSet(inventory.protected_paths, 'Protected paths', true);
  inventory.limitations = sortedSet(inventory.limitations, 'Limitations');
  for (const unit of inventory.units) {
    sortedSet(unit.files.map(file => file.path), 'Unit source paths', true);
    unit.files.sort((a, b) => a.path.localeCompare(b.path));
    unit.dependency_paths = sortedSet(unit.dependency_paths, 'Dependency paths', true);
    unit.items = sortedSet(unit.items, 'Mapped items');
    unit.criteria = sortedSet(unit.criteria, 'Mapped criteria');
    unit.evidence_refs = sortedSet(unit.evidence_refs, 'Evidence references');
    if (unit.disposition === 'mapped' ? !unit.items.length || !unit.criteria.length : unit.items.length || unit.criteria.length) {
      fail('ADOPTION_MAPPING_INVALID', 2, 'Mapped units require items and acceptance; excluded/unknown units cannot claim mappings.', { unit: unit.id });
    }
    if (unit.scope === 'outside' && unit.disposition === 'mapped') fail('ADOPTION_MAPPING_INVALID', 2, 'An outside unit cannot count as adopted intent.', { unit: unit.id });
  }
  const units = new Map(inventory.units.map(unit => [unit.id, unit]));
  for (const section of inventory.accounting) {
    section.unit_ids = sortedSet(section.unit_ids, 'Accounting unit IDs');
    const expected = inventory.units.filter(unit => unit.kind === section.kind).map(unit => unit.id).sort();
    if (canonical(section.unit_ids) !== canonical(expected) || (expected.length ? section.none_reason !== null : section.none_reason === null)) {
      fail('ADOPTION_ACCOUNTING_INCOMPLETE', 5, 'Every kind must list all its units or explicitly explain none declared.', { kind: section.kind });
    }
  }
  for (const exclusion of inventory.exclusions) {
    if (units.get(exclusion.unit_id)?.disposition !== 'excluded') fail('ADOPTION_MAPPING_INVALID', 2, 'Exclusion must name an excluded declared unit.');
  }
  for (const question of inventory.questions) {
    question.unit_ids = sortedSet(question.unit_ids, 'Question unit IDs');
    if (question.unit_ids.some(unitId => !units.has(unitId))) fail('ADOPTION_MAPPING_INVALID', 2, 'Question names an undeclared unit.');
  }
  for (const unit of inventory.units) {
    if ((unit.disposition === 'excluded') !== inventory.exclusions.some(exclusion => exclusion.unit_id === unit.id)) fail('ADOPTION_MAPPING_INVALID', 2, 'Excluded units require exactly one explicit rationale.', { unit: unit.id });
    if (unit.disposition === 'unknown' && !inventory.questions.some(question => question.unit_ids.includes(unit.id))) fail('ADOPTION_ACCOUNTING_INCOMPLETE', 5, 'Unknown units need a visible unresolved question.', { unit: unit.id });
  }
  inventory.units.sort((a, b) => a.id.localeCompare(b.id));
  inventory.accounting.sort((a, b) => a.kind.localeCompare(b.kind));
  inventory.exclusions.sort((a, b) => a.unit_id.localeCompare(b.unit_id));
  inventory.questions.sort((a, b) => a.id.localeCompare(b.id));
  return inventory;
}

// This checks a supplied immutable snapshot, never the live filesystem or its authority.
export function validateAdoptionInventory(input: unknown, sourceInput: unknown): { inventory: AdoptionInventory; source: SourceSnapshot } {
  const inventory = normalizeAdoptionInventory(input), source = validateSourceSnapshot(sourceInput), sourceDigest = digest(source);
  if (inventory.project_id !== source.project_id || inventory.source.sha256 !== sourceDigest || inventory.source.ref !== 'source-snapshot@' + sourceDigest) {
    fail('SOURCE_INTEGRITY', 6, 'Inventory must pin the exact project and content-addressed source snapshot.');
  }
  const entries = new Map(source.entries.map(entry => [entry.path, entry]));
  const checkPath = (name: string, expectedHash?: string) => {
    const entry = entries.get(name);
    if (!entry || entry.presence !== 'present' || entry.kind !== 'regular' || (expectedHash !== undefined && expectedHash !== entry.sha256)) {
      fail('SOURCE_COVERAGE_INCOMPLETE', 5, 'Adoption paths must name present ordinary files with exact captured bytes.', { path: name });
    }
  };
  for (const name of inventory.protected_paths) checkPath(name);
  for (const unit of inventory.units) {
    for (const file of unit.files) checkPath(file.path, file.sha256);
    for (const name of unit.dependency_paths) checkPath(name);
  }
  return { inventory, source };
}
