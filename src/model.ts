import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MODEL = 'strata/0.1-facets-experimental';
export const CONTENT_MODEL = 'strata/0.2-content-mediation-experimental';
export const BLOCK_MODEL = 'strata/0.3-block-lifecycle-experimental';
export const SUPPORTED_MODELS = [MODEL, CONTENT_MODEL, BLOCK_MODEL] as const;
export const isContentModel=(model:string)=>model===CONTENT_MODEL||model===BLOCK_MODEL;
export const FACETS = ['behavior', 'design', 'data', 'safety'] as const;
export class StrataError extends Error {
  constructor(public code: string, public exit: number, message: string, public details: unknown = null) { super(message); }
}
export function fail(code: string, exit: number, message: string, details?: unknown): never { throw new StrataError(code, exit, message, details); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  if (value === undefined) fail('INVALID_RECORD', 2, 'Undefined is not a model value.');
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const bytesDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function set<T extends string>(values: T[]): T[] {
  if (new Set(values).size !== values.length) fail('INVALID_RECORD', 2, 'A declared set contains duplicate members.');
  return [...values].sort();
}
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const ref = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const facets = z.array(z.enum(FACETS)).min(1);
const strings = z.array(z.string());
export const requirementSchema = z.object({ statement: z.string().min(1), kind: z.enum(['rule', 'invariant']), facets, acceptance: strings, parameters: z.record(z.string(), z.unknown()) }).strict();
export const criterionSchema = z.object({ statement: z.string().min(1), method: z.enum(['mechanical', 'review']), check: id, version: z.string().min(1), fixture: z.string().min(1), subjects: strings }).strict();
const entrySchema = z.object({ statement: z.string().min(1), acceptance: strings }).strict();
const relationSchema = z.object({ target: id, statement: z.string().min(1), acceptance: strings }).strict();
export const blockSchema = z.object({ id, parent: id.nullable(), purpose: z.string().min(1), requirements: z.record(id, requirementSchema), acceptance: z.record(id, criterionSchema), relationships: z.record(id, relationSchema), contract: z.object({ inputs: z.record(id, entrySchema), outputs: z.record(id, entrySchema), failures: z.record(id, entrySchema) }).strict() }).strict();
const authorities = z.object({ scopes: z.array(z.object({ block: id, selectors: strings }).strict()), release: strings, guardians: z.array(z.object({ item: z.string(), principal: z.string() }).strict()) }).strict();
export const snapshotSchema = z.object({ id, revision: z.number().int().positive(), model_version: z.literal(MODEL), root: id, blocks: z.record(id, blockSchema), authorities, deleted_ids: strings }).strict();
export const expectedSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('absent') }).strict(), z.object({ kind: z.literal('value'), value: z.unknown() }).strict(), z.object({ kind: z.literal('fingerprint'), fingerprint: z.string().length(64) }).strict()]);
export const changeSchema = z.object({ op: z.literal('set_item'), block: id, path: z.string().min(1), expected: expectedSchema, value: z.unknown() }).strict();
const resolutionPayloadSchema = z.object({ input_fingerprint: z.string().length(64), scope: id, impact: strings, outcome: z.object({ kind: z.literal('select'), selected: z.array(ref), rejected: z.array(ref) }).strict() }).strict();
export const layerSchema = z.object({ id, revision: z.number().int().positive(), owner: z.string().min(1), model_version: z.literal(MODEL), baseline: ref, intent: z.string().min(1), changes: z.array(changeSchema), requires_layers: z.array(ref), read_set: z.array(z.object({ layer: ref, mode: z.enum(['required', 'informational']) }).strict()), assumptions: z.array(z.object({ block: id, path: z.string(), expected: expectedSchema }).strict()), acceptance: z.array(z.object({ block: id, id, criterion: criterionSchema }).strict()), resolution_proposals: z.array(resolutionPayloadSchema), derived_from: z.object({ kind: z.literal('supplied_proposal'), source_digest: z.string().length(64), against: ref, traceability: z.array(z.object({ item: z.string(), classification: z.enum(['observed', 'inferred', 'correction', 'uncovered']), rationale: z.string().min(1), files: strings }).strict()), questions: strings }).strict().nullable() }).strict();
export const compositionSchema = z.object({ id, revision: z.number().int().positive(), model_version: z.literal(MODEL), baseline: ref, proposals: z.array(ref), selected: z.array(ref), alternative_groups: z.array(z.object({ id, members: z.array(ref), min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).strict()), scenario: z.object({ id, checks: z.array(z.object({ id, version: z.string().min(1) }).strict()) }).strict(), resolutions: z.array(ref) }).strict();
export const approvalSchema = z.object({ kind: z.enum(['resolution', 'scope', 'guardian', 'release']), target: z.string().min(1), scope: z.string().nullable(), evidence_digest: z.string().nullable() }).strict();
export const evidenceSchema = z.object({ candidate: z.string().length(64), profile: z.string().length(64), output_tree: z.string().length(64), executor: z.literal('strata-local-fixture-runner/1'), results: z.array(z.object({ check: z.string(), version: z.string(), fixture: z.string(), passed: z.boolean(), method: z.enum(['mechanical', 'review']), reviewer: z.string().nullable() }).strict()) }).strict();
// v0.1 schemas above remain the exact legacy machine contract.
const hash256 = z.string().regex(/^[a-f0-9]{64}$/);
const contentRef = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/);
const localKey = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const plainTextSchema = z.string().superRefine((text, ctx) => {
  if (new TextEncoder().encode(text).length > 4096) ctx.addIssue({ code: 'custom', message: 'Intent text exceeds 4096 UTF-8 bytes.' });
  if (/[`]|<[A-Za-z/!]|(?:javascript|data|vbscript):|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/i.test(text)) ctx.addIssue({ code: 'custom', message: 'Intent is plain text: code spans/fences, HTML, script URLs and control characters are unsupported.' });
});
const textRequired = plainTextSchema.pipe(z.string().min(1));
export const descriptionSchema = z.object({ format: z.literal('plain-text/1'), text: plainTextSchema }).strict();
// Content shape is domain neutral. Compiled profiles recognize exact supported
// parameter names and meanings before materialization, validation or Release.
const parameterSchema = z.record(z.string(), z.union([z.number().finite(), z.boolean()]));
export const contentRequirementSchema = requirementSchema.extend({ statement: textRequired, acceptance: strings.min(1), parameters: parameterSchema }).strict();
export const contentCriterionSchema = criterionSchema.extend({ statement: textRequired, version: textRequired, fixture: textRequired, subjects: strings.min(1) }).strict();
export const assetReferenceSchema = z.object({ asset_ref: z.string().regex(/^asset@[a-f0-9]{64}$/), content_sha256: hash256, role: z.enum(['background','application_resource','normative_reference','evidence_fixture']), subjects: strings }).strict();
export const contentBlockSchema = blockSchema.extend({
  purpose: textRequired,
  requirements: z.record(localKey, contentRequirementSchema),
  acceptance: z.record(localKey, contentCriterionSchema),
  relationships: z.record(localKey, relationSchema.extend({ statement: textRequired }).strict()),
  contract: z.object({ inputs: z.record(localKey, entrySchema.extend({ statement: textRequired }).strict()), outputs: z.record(localKey, entrySchema.extend({ statement: textRequired }).strict()), failures: z.record(localKey, entrySchema.extend({ statement: textRequired }).strict()) }).strict(),
  description: descriptionSchema,
  asset_refs: z.record(localKey, assetReferenceSchema).refine(value => Object.keys(value).length <= 8, 'At most eight asset references per Block.')
}).strict();
export const contentSnapshotSchema = snapshotSchema.extend({ model_version: z.literal(CONTENT_MODEL), blocks: z.record(id, contentBlockSchema) }).strict();
// Explicit v0.2 forms; the server runtime supplies mediation authorization.
export const contentSelectionSchema = resolutionPayloadSchema.extend({ format: z.literal('selection/2'), basis_ref: z.string().regex(/^mediation-basis@[a-f0-9]{64}$/), basis_sha256: hash256, rationale: textRequired }).strict();
export const contentLayerSchema = layerSchema.extend({ model_version: z.literal(CONTENT_MODEL), intent: textRequired, acceptance: z.array(z.object({ block: id, id: localKey, criterion: contentCriterionSchema }).strict()), resolution_proposals: z.array(contentSelectionSchema) }).strict();
export const contentCompositionSchema = compositionSchema.extend({ model_version: z.literal(CONTENT_MODEL) }).strict();
export const frozenContentApprovalSchema = z.object({ format: z.literal('approval/2'), project_id: id, model_version: z.literal(CONTENT_MODEL), baseline: contentRef, authority_sha256: hash256, kind: z.enum(['resolution','scope','guardian','release']), target: hash256, scope: id.nullable(), evidence_digest: hash256.nullable(), generation: z.string().min(1), expires_at: z.string().datetime().nullable(), binding: z.object({ basis_ref: z.string(), packet_ref: z.string(), case_revision: z.number().int().positive(), option_id: localKey, partition_sha256: hash256, receipt_ref: z.string() }).strict().nullable() }).strict();
// The active reader also represents fixed guardian items already used by baseline authority.
export const contentApprovalSchema=frozenContentApprovalSchema.extend({scope:z.union([id,z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)]).nullable()}).strict();
export const assetInputSchema = z.object({ id: localKey, revision: z.number().int().positive(), previous: z.string().regex(/^asset@[a-f0-9]{64}$/).nullable(), title: textRequired, access: z.literal('project-private'), acknowledge_project_visibility: z.literal(true), source: z.object({ kind: z.enum(['local-created','local-provided']), provider: textRequired, attribution: plainTextSchema, permitted_uses: z.array(z.enum(['internal-retention','backup'])).length(2).refine(values=>new Set(values).size===2,'Both retention and backup rights are required.') }).strict() }).strict();
export const assetDescriptorSchema = assetInputSchema.omit({ acknowledge_project_visibility: true }).extend({ format: z.literal('strata-asset/1'), project_id: id, content_sha256: hash256, byte_length: z.number().int().positive().max(4194304), media_type: z.enum(['image/png','image/jpeg']), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), validation: z.literal('bounded-structure/1'), imported_by: z.string().min(1) }).strict();
export const authoringReviewSchema = z.object({ format: z.literal('authoring-review/1'), project_id: id, model_version: z.literal(CONTENT_MODEL), draft_ref: contentRef, draft_digest: hash256, checklist: z.literal('intent-authoring/1'), accepted: z.boolean(), rationale: textRequired, reviewer: z.string().min(1), trust: z.literal('local-fixture') }).strict();
export const blockSnapshotSchema=contentSnapshotSchema.extend({model_version:z.literal(BLOCK_MODEL)}).strict();
export const hostSelectionSchema=contentSelectionSchema.extend({format:z.literal('selection/3')}).strict();
export const blockLayerSchema=contentLayerSchema.extend({model_version:z.literal(BLOCK_MODEL),created_blocks:z.array(contentBlockSchema).max(100),resolution_proposals:z.array(hostSelectionSchema)}).strict();
export const blockCompositionSchema=contentCompositionSchema.extend({model_version:z.literal(BLOCK_MODEL)}).strict();
export const blockAuthoringReviewSchema=authoringReviewSchema.extend({model_version:z.literal(BLOCK_MODEL)}).strict();
export type AssetDescriptor = z.infer<typeof assetDescriptorSchema>;
export type Block = z.infer<typeof blockSchema> & { description?: z.infer<typeof descriptionSchema>; asset_refs?: Record<string,z.infer<typeof assetReferenceSchema>> };
export type Snapshot = Omit<z.infer<typeof snapshotSchema>, 'model_version'|'blocks'> & { model_version: typeof MODEL | typeof CONTENT_MODEL | typeof BLOCK_MODEL; blocks: Record<string,Block> };
export type Layer = Omit<z.infer<typeof layerSchema>,'model_version'> & { model_version: typeof MODEL | typeof CONTENT_MODEL | typeof BLOCK_MODEL; created_blocks?:Block[] };
export type Composition = Omit<z.infer<typeof compositionSchema>,'model_version'> & { model_version: typeof MODEL | typeof CONTENT_MODEL | typeof BLOCK_MODEL };
export function parseLayer(input: any): Layer { return input?.model_version===BLOCK_MODEL?parse(blockLayerSchema,input):input?.model_version === CONTENT_MODEL ? parse(contentLayerSchema,input) : parse(layerSchema,input); }
export function parseComposition(input: any): Composition { return input?.model_version===BLOCK_MODEL?parse(blockCompositionSchema,input):input?.model_version === CONTENT_MODEL ? parse(contentCompositionSchema,input) : parse(compositionSchema,input); }
export type Change = z.infer<typeof changeSchema>;
export const boundEvidenceSchema=evidenceSchema.extend({format:z.literal('strata-fixture-evidence/2'),checker_sha256:z.string().regex(/^[a-f0-9]{64}$/),fixture_sha256:z.string().regex(/^[a-f0-9]{64}$/),oracle_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type Evidence = z.infer<typeof evidenceSchema>|z.infer<typeof boundEvidenceSchema>;
export function parseEvidence(input:any):Evidence {return input?.format==='strata-fixture-evidence/2' ? parse(boundEvidenceSchema,input) : parse(evidenceSchema,input);}
export type Approval = z.infer<typeof approvalSchema> & { principal: string; trust: 'local-fixture'; ref: string };
export type Stored = { type: string; data: any; published: boolean };
export type Records = Record<string, Stored>;
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('INVALID_RECORD', 2, 'Record does not match the experimental schema.', result.error.issues);
  return result.data;
}
export function item(block: Block, path: string): { exists: boolean; value?: unknown } {
  if (path === 'purpose' || path === 'parent' || (path === 'description' && block.description)) return { exists: true, value: (block as any)[path] };
  const parts = path.split('.');
  if (parts.length === 2 && ['requirements', 'acceptance', 'relationships', ...(block.asset_refs ? ['asset_refs'] : [])].includes(parts[0])) {
    const collection = (block as any)[parts[0]];
    return { exists: Object.hasOwn(collection, parts[1]), value: collection[parts[1]] };
  }
  if (parts.length === 3 && parts[0] === 'contract' && ['inputs', 'outputs', 'failures'].includes(parts[1])) {
    const collection = (block.contract as any)[parts[1]];
    return { exists: Object.hasOwn(collection, parts[2]), value: collection[parts[2]] };
  }
  fail('UNSUPPORTED_CAPABILITY', 8, 'Editable paths are atomic keyed semantic items or purpose.', { path });
}
export function matches(actual: ReturnType<typeof item>, expected: z.infer<typeof expectedSchema>): boolean {
  if (expected.kind === 'absent') return !actual.exists;
  if (!actual.exists) return false;
  return expected.kind === 'value' ? canonical(actual.value) === canonical(expected.value) : digest(actual.value) === expected.fingerprint;
}
export function write(block: Block, path: string, value: unknown): void {
  item(block, path);
  if (path === 'parent') fail('UNSUPPORTED_CAPABILITY', 8, 'Reparenting is outside the initial mutation subset.');
  if (path === 'purpose') { block.purpose = parse(block.description ? textRequired : z.string().min(1), value); return; }
  if (path === 'description' && block.description) { block.description = parse(descriptionSchema, value); return; }
  const parts = path.split('.');
  const schema = parts[0] === 'asset_refs' ? assetReferenceSchema : parts[0] === 'requirements' ? (block.description ? contentRequirementSchema : requirementSchema) : parts[0] === 'acceptance' ? (block.description ? contentCriterionSchema : criterionSchema) : parts[0] === 'relationships' ? relationSchema : entrySchema;
  const parsed: any = parse(schema as z.ZodType<any>, value);
  if (block.description && ['requirements','relationships','contract'].includes(parts[0]) && (item(block,path).value as any)?.acceptance.some((c:string) => !parsed.acceptance.includes(c))) fail('OBLIGATION_REMOVAL_UNSUPPORTED', 8, 'content/1 cannot silently remove inherited requirement acceptance.');
  if (block.description && parts[0] === 'acceptance' && block.acceptance[parts[1]] && canonical(parsed) !== canonical(block.acceptance[parts[1]])) fail('OBLIGATION_REMOVAL_UNSUPPORTED', 8, 'content/1 retains inherited criteria; criterion replacement requires a later explicit amendment contract.');
  if (parts[0] === 'requirements') { parsed.facets = set(parsed.facets); parsed.acceptance = set(parsed.acceptance); }
  if (parts[0] === 'acceptance') parsed.subjects = set(parsed.subjects);
  if (parts[0] === 'relationships' || parts[0] === 'contract') parsed.acceptance = set(parsed.acceptance);
  if (parts.length === 2) (block as any)[parts[0]][parts[1]] = parsed;
  else (block.contract as any)[parts[1]][parts[2]] = parsed;
}
export const itemRef = (block: string, path: string) => `${block}/${path}`;
export function normalizeSnapshot(input: unknown): Snapshot {
  const snapshot: Snapshot = (input as any)?.model_version===BLOCK_MODEL?parse(blockSnapshotSchema,input):(input as any)?.model_version === CONTENT_MODEL ? parse(contentSnapshotSchema,input) : parse(snapshotSchema,input);
  for (const block of Object.values(snapshot.blocks)) {
    for (const [key, value] of Object.entries(block.requirements)) write(block, 'requirements.' + key, value);
    for (const [key, value] of Object.entries(block.acceptance)) write(block, 'acceptance.' + key, value);
    for (const [key, value] of Object.entries(block.relationships)) write(block, 'relationships.' + key, value);
    for (const collection of ['inputs', 'outputs', 'failures'] as const) for (const [key, value] of Object.entries(block.contract[collection])) write(block, `contract.${collection}.${key}`, value);
  }
  snapshot.deleted_ids = set(snapshot.deleted_ids);
  snapshot.authorities.release = set(snapshot.authorities.release);
  snapshot.authorities.scopes = snapshot.authorities.scopes.map(s => ({ ...s, selectors: set(s.selectors) })).sort((a, b) => a.block.localeCompare(b.block));
  snapshot.authorities.guardians.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  checkTree(snapshot);
  return snapshot;
}
export function checkTree(snapshot: Snapshot): void {
  const { blocks, root } = snapshot;
  if (isContentModel(snapshot.model_version)) for (const block of Object.values(blocks)) {
    parse(contentBlockSchema, block);
    for(const criterion of Object.values(block.acceptance)) for(const subject of criterion.subjects) {
      const path=subject.slice(subject.indexOf('/')+1);
      if(path.startsWith('asset_refs.')) fail('UNSUPPORTED_ASSET_ROLE',8,'Background assets cannot be promoted to normative acceptance subjects.');
      if(path==='description') fail('UNSUPPORTED_CAPABILITY',8,'Descriptions are explanatory; normative acceptance must bind semantic requirements or contracts.');
    }
    for (const reference of Object.values(block.asset_refs ?? {})) {
      if (reference.role !== 'background') fail('UNSUPPORTED_ASSET_ROLE', 8, 'assets/1 supports background retention only.');
      if (reference.subjects.length) fail('INVALID_RECORD', 2, 'Background references are explanatory and have no normative subjects.');
    }
  }
  if (!blocks[root] || blocks[root].parent !== null) fail('INVALID_TREE', 2, 'A snapshot needs one declared root.');
  for (const [key, block] of Object.entries(blocks)) {
    if (key !== block.id || snapshot.deleted_ids.includes(key)) fail('INVALID_TREE', 2, 'Block identity is inconsistent or reserved.');
    const seen = new Set<string>(); let current: Block | undefined = block;
    while (current && current.id !== root) {
      if (seen.has(current.id) || current.parent === null || !blocks[current.parent]) fail('INVALID_TREE', 2, 'Every Block must connect to the root without cycles.');
      seen.add(current.id); current = blocks[current.parent];
    }
    for (const value of Object.values(block.relationships)) if (!blocks[value.target]) fail('DANGLING_REFERENCE', 2, 'Relationship target is absent.');
    for (const [name, criterion] of Object.entries(block.acceptance)) {
      if (criterion.subjects.length === 0) fail('INVALID_RECORD', 2, 'Acceptance subjects cannot be empty.');
      for (const subject of criterion.subjects) {
        const slash = subject.indexOf('/'); const b = blocks[subject.slice(0, slash)];
        if (!b || slash < 0 || !item(b, subject.slice(slash + 1)).exists) fail('DANGLING_REFERENCE', 2, 'Acceptance subject is absent.', { name, subject });
      }
    }
    const collections = [block.requirements, block.relationships, ...Object.values(block.contract)];
    for (const collection of collections) for (const value of Object.values(collection)) for (const criterion of value.acceptance) {
      if (!block.acceptance[criterion]) fail('DANGLING_REFERENCE', 2, 'An item references an absent local acceptance criterion.', { criterion });
    }
  }
  for (const scope of snapshot.authorities.scopes) if (!blocks[scope.block]) fail('INVALID_AUTHORITY', 2, 'Authority scope must exist in the baseline.');
  for (const guard of snapshot.authorities.guardians) {
    const slash = guard.item.indexOf('/'); const b = blocks[guard.item.slice(0, slash)];
    if (!b || !item(b, guard.item.slice(slash + 1)).exists) fail('INVALID_AUTHORITY', 2, 'Protected item must exist in the baseline.');
  }
}
export function blockFacets(block: Block) { return [...new Set(Object.values(block.requirements).flatMap(r => r.facets))].sort(); }
export function ancestors(snapshot: Snapshot, block: string): string[] {
  const result: string[] = []; let next: string | null = block;
  while (next !== null) { if (!snapshot.blocks[next]) fail('REF_NOT_FOUND', 3, 'Impact Block is absent.'); result.push(next); next = snapshot.blocks[next].parent; }
  return result;
}
export function responsible(snapshot: Snapshot, impact: string[]): string {
  if (!impact.length) return snapshot.root;
  const paths = impact.map(b => ancestors(snapshot, b));
  const scope = paths[0].find(b => paths.every(p => p.includes(b)) && snapshot.authorities.scopes.some(s => s.block === b));
  if (!scope) fail('AUTHORITY_REQUIRED', 4, 'No baseline authority covers the whole impact.');
  return scope;
}
export function impactClosure(snapshot: Snapshot, touched: string[]): string[] {
  const result = new Set(touched); let changed = true;
  while (changed) {
    changed = false;
    for (const block of Object.values(snapshot.blocks)) if (Object.values(block.relationships).some(r => result.has(r.target)) && !result.has(block.id)) { result.add(block.id); changed = true; }
    for (const block of Object.values(snapshot.blocks)) if (Object.values(block.acceptance).some(c => c.subjects.some(s => result.has(s.split('/')[0]))) && !result.has(block.id)) { result.add(block.id); changed = true; }
  }
  return [...result].sort();
}
