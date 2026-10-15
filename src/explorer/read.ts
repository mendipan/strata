import { randomBytes } from 'node:crypto';
import { Engine, snapshotFromRelease, obligations } from '../core.js';
import { ancestors, blockFacets, canonical, digest, bytesDigest, item, FACETS, CONTENT_MODEL, BLOCK_MODEL,isContentModel, type Records, type Snapshot, type Composition } from '../model.js';
import { ExplorerError, LIMITS, RECORD_TYPES, problem, type SourceInfo } from './contract.js';
import type { ExplorerSource } from './source.js';
import { validateRecords } from './validate.js';

type Generation = { records: Records; source: SourceInfo; engine: Engine };
// Read-only pinned policy, separate from current evidence and approval coverage.
function authorityItems(snapshot: Snapshot) {
  const values = new Map<string, { block: string | null; value: any }>();
  values.set('authorities.release', { block: null, value: [...snapshot.authorities.release].sort() });
  for (const scope of snapshot.authorities.scopes) {
    const key = 'authorities.scopes.' + scope.block;
    const row = values.get(key) ?? { block: scope.block, value: [] };
    row.value.push({ block: scope.block, selectors: [...scope.selectors].sort() }); values.set(key, row);
  }
  for (const guardian of snapshot.authorities.guardians) {
    const key = 'authorities.guardians.' + guardian.item;
    const row = values.get(key) ?? { block: guardian.item.split('/')[0], value: [] };
    row.value.push({ ...guardian }); values.set(key, row);
  }
  for (const row of values.values()) row.value.sort((a: any, b: any) => canonical(a).localeCompare(canonical(b)));
  return values;
}
export type ReviewDraftGrant = { project_id: string; ref: string; sha256: string; expires_at: string };
function freeze(value: any): any { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) freeze(v); } return value; }
const notFound = () => problem('REF_NOT_FOUND', 404, 'This reference is unavailable.');
const snippet = (text: string) => text.length > 160 ? text.slice(0,157) + '…' : text;
const supportFields: Record<string, string[]> = {
  interaction: ['composition','candidate','principal','message','ref'],
  'interaction-report': ['format','project_id','model_version','composition','candidate','principal','message','affected_items','contributors','evidence_refs'],
  'report-disposition': ['format','project_id','model_version','report_ref','kind','rationale','evidence_refs','principal','scope','selection_context_sha256','authority_sha256'],
  'mediation-basis': ['format','project_id','model_version','composition_ref','baseline','input_fingerprint','case_id','case_revision','expires_at','goal','impact','scope','reports','policy_status','policy_reason','alternatives'],
  'decision-packet': ['format','project_id','model_version','basis_ref','basis_sha256','case_id','case_revision','expires_at','goal','question','recommendation','options','defer','costs','required_authorities','remaining_gates'],
  'mediation-receipt': ['format','project_id','model_version','packet_ref','basis_ref','case_id','case_revision','action','option_id','target','partition_sha256','principal','origin','created_at','message']
};
export class ExplorerReader {
  private lifecycle = 0;
  private generation?: Generation;
  private refreshing = false;
  private active = 0;
  private lastError: ExplorerError | null = null;
  private cursors = new Map<string, { generation: string; signature: string; offset: number }>();
  private readonly reviewDraft?: Readonly<ReviewDraftGrant>;
  private readonly ownedPrincipal?:()=>string|null;
  private readonly retainedRefs?:Readonly<Record<string,string>>;
  constructor(readonly source: ExplorerSource, options: { reviewDraft?: ReviewDraftGrant; ownedPrincipal?:()=>string|null;retainedRefs?:Record<string,string> } = {}) {
    this.ownedPrincipal=options.ownedPrincipal;
    this.reviewDraft = options.reviewDraft ? Object.freeze({ ...options.reviewDraft }) : undefined;
    this.retainedRefs=options.retainedRefs?Object.freeze({...options.retainedRefs}):undefined;
  }
  private authorize() {
    try {
      const review = this.reviewDraft;
      if (review && (review.project_id !== this.source.connection.project_id || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/.test(review.ref) || !/^[a-f0-9]{64}$/.test(review.sha256) || !Number.isFinite(Date.parse(review.expires_at)) || Date.parse(review.expires_at) <= Date.now())) problem('SOURCE_AUTH', 403, 'Draft review authorization needs attention.');
      this.source.assertAuthorized();
    }
    catch (error) { this.generation = undefined; this.cursors.clear(); throw error; }
  }
  connection() {
    this.authorize();
    return { ...this.source.connection, ready: !!this.generation, source: this.generation?.source ?? null, error: this.lastError ? { code: this.lastError.code, message: this.lastError.message, retryable: this.lastError.retryable } : null, scope: this.retainedRefs ? 'Project records, imported drafts and your new drafts' : this.reviewDraft ? 'Published project records and one owner-authorized review draft' : 'Published project records', draft_review: this.reviewDraft ?? null, capabilities: { read_only: true, current_mediation_policy: false, asset_rendering: false }, limits: { records: LIMITS.records, json_bytes: LIMITS.jsonBytes, blocks: LIMITS.blocks } };
  }
  invalidate() {
    this.lifecycle++; this.generation = undefined; this.cursors.clear(); this.lastError = null;
  }
  async refresh(options: { signal?: AbortSignal } = {}) {
    this.authorize();
    if (this.refreshing) problem('REFRESH_BUSY', 409, 'A read refresh is already in progress.', true);
    this.refreshing = true;
    const lifecycle = this.lifecycle;
    let aborted: (() => void) | undefined;
    try {
      const signal = options.signal;
      if (signal?.aborted) problem('SOURCE_UNAVAILABLE', 503, 'The bounded source read was interrupted.', true);
      const loaded = await Promise.race([this.source.load(signal), ...(signal ? [new Promise<never>((_, reject) => {
        aborted = () => reject(new ExplorerError('SOURCE_UNAVAILABLE', 503, 'The bounded source read was interrupted.', true));
        signal.addEventListener('abort', aborted, { once: true });
      })] : [])]);
      if (lifecycle !== this.lifecycle) problem('CONNECTION_CHANGED', 409, 'The connection changed during its read.', true);
      validateRecords(loaded.records, this.source.connection.project_id, this.source.connection.model_version);
      this.authorize();
      if (lifecycle !== this.lifecycle) problem('CONNECTION_CHANGED', 409, 'The connection changed during its read.', true);
      const review = this.reviewDraft;
      if (review) {
        const draft = loaded.records[review.ref];
        if (!draft || draft.type !== 'layer' || draft.published || bytesDigest(canonical(draft.data)) !== review.sha256) problem('SOURCE_BINDING', 403, 'The exact authorized review draft does not match.');
      }
      const visible = Object.fromEntries(Object.entries(loaded.records).filter(([ref, r]) => r.published || ref === review?.ref || this.retainedRefs?.[ref]===digest(r.data) || (!!this.ownedPrincipal?.() && r.data.owner===this.ownedPrincipal())));
      const records = freeze(structuredClone(visible));
      const engine = new Engine(records, {}, { projectId: this.source.connection.project_id, modelVersion: this.source.connection.model_version as any, assetBytes: loaded.assetBytes, historical: true });
      // Fail generation-wide if an existing composition cannot be safely evaluated.
      for (const r of Object.values(records) as any[]) if (r.type === 'composition') engine.evaluate(r.data);
      if (this.generation?.source.registry_generation !== loaded.source.registry_generation) this.cursors.clear();
      this.generation = { records, source: loaded.source, engine }; this.lastError = null;
      return this.connection();
    } catch (error) {
      if (lifecycle !== this.lifecycle) problem('CONNECTION_CHANGED', 409, 'The connection changed during its read.', true);
      const safe = error instanceof ExplorerError ? error : new ExplorerError('CORRUPT_DATA', 422, 'Project records could not be verified.');
      this.lastError = safe;
      if (safe.code === 'SOURCE_UNAVAILABLE' && this.generation) { this.authorize(); this.generation.source = { ...this.generation.source, freshness: 'stale-network' }; }
      else { this.generation = undefined; this.cursors.clear(); }
      throw safe;
    } finally { if (aborted) options.signal?.removeEventListener('abort', aborted); this.refreshing = false; }
  }
  private current(generation: string | null) {
    this.authorize();
    if (!this.generation) problem('CONNECTION_NOT_READY', 503, 'Connection not ready. Configure a trusted registry and existing Artifacts read connection.');
    if (generation !== this.generation!.source.registry_generation) problem('STALE_GENERATION', 409, 'The record list changed. Refresh results to use one consistent registry view.', true);
    return this.generation!;
  }
  private record(g: Generation, ref: string, type?: string) {
    const r = Object.hasOwn(g.records, ref) ? g.records[ref] : undefined;
    if (!r || (type && r.type !== type) || (!RECORD_TYPES.includes(r.type as any) && !supportFields[r.type])) return notFound();
    if (supportFields[r.type] && !this.supportingRefs(g).has(ref)) return notFound();
    return r;
  }
  private supportingRefs(g: Generation) {
    const refs = new Set<string>();
    for (const [ref, r] of Object.entries(g.records)) {
      const d = r.data;
      if ((r.type === 'interaction' || r.type === 'interaction-report') && g.records[d.composition]?.type === 'composition') refs.add(ref);
      if (r.type === 'mediation-basis' && g.records[d.composition_ref]?.type === 'composition') refs.add(ref);
    }
    for (let pass = 0; pass < 6; pass++) for (const [ref, r] of Object.entries(g.records)) {
      if ((r.type === 'decision-packet' && refs.has(r.data.basis_ref)) || (r.type === 'mediation-receipt' && refs.has(r.data.packet_ref)) || (r.type === 'report-disposition' && refs.has(r.data.report_ref))) refs.add(ref);
    }
    return refs;
  }
  private evaluation(g: Generation, ref: string) {
    const record = this.record(g, ref, 'composition'), evaluation = g.engine.evaluate(record.data as Composition);
    const coverage = isContentModel(record.data.model_version) ? 'structural-only' : 'current-policy';
    return { evaluation, coverage };
  }
  private target(g: Generation, ref: string) {
    const record = this.record(g, ref);
    if (record.type === 'release') return g.engine.target(ref);
    if (record.type !== 'composition') return notFound();
    const { evaluation, coverage } = this.evaluation(g, ref);
    if (evaluation.state === 'blocked' || coverage !== 'current-policy') problem('BLOCKED_COMPARISON', 409, 'An effective comparison is unavailable. Inspect conflicts and current authority coverage.');
    return evaluation;
  }
  private page(g: Generation, rows: any[], q: URLSearchParams, signature: unknown) {
    const raw = q.get('limit') ?? '25'; if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 100) problem('INVALID_INPUT', 400, 'List limit must be 1 through 100.');
    const limit = +raw, sig = digest(signature), cursor = q.get('cursor'); let offset = 0;
    if (cursor) { const c = this.cursors.get(cursor); if (!c || c.generation !== g.source.registry_generation || c.signature !== sig) problem('STALE_CURSOR', 409, 'The record list changed. Refresh results.', true); offset = c!.offset; }
    let next_cursor: string | null = null;
    if (offset + limit < rows.length) {
      if (this.cursors.size >= 512) this.cursors.delete(this.cursors.keys().next().value!);
      next_cursor = Buffer.from(randomBytes(24)).toString('base64url'); this.cursors.set(next_cursor!, { generation: g.source.registry_generation, signature: sig, offset: offset + limit });
    }
    return { items: rows.slice(offset, offset + limit), total: rows.length, next_cursor };
  }
  evidence(g: Generation, target: string) {
    const record = this.record(g, target), evaluation = record.type === 'composition' ? this.evaluation(g, target).evaluation : this.target(g, target);
    const candidate = evaluation.fingerprint, matches: string[] = [], mismatches: string[] = [];
    const origin = record.type === 'release' && record.data.validation ? g.records[record.data.validation]?.data.target : target;
    for (const [ref, r] of Object.entries(g.records)) if (r.type === 'validation' && (r.data.target === origin || r.data.candidate === candidate || ref === record.data.validation)) {
      const v = r.data, e = v.evidence, realization = g.records[v.realization]?.data;
      let binds = v.target === origin && v.candidate === candidate && e.candidate === candidate && v.evidence_digest === digest(e) && realization?.target === origin && realization?.candidate === candidate && e.profile === realization?.profile && e.output_tree === realization?.output_tree;
      if (realization?.format === 'strata-realization/2') binds &&= e.format === (record.data.model_version===BLOCK_MODEL?'strata-host-evidence/1':'strata-fixture-evidence/2') && ['checker_sha256','fixture_sha256','oracle_sha256'].every(k => e[k] === realization[k]);
      else binds &&= e.format === undefined;
      for (const block of Object.values(evaluation.snapshot.blocks)) for (const criterion of Object.values(block.acceptance)) {
        const results = e.results.filter((r: any) => ['check','version','fixture','method'].every(k => r[k] === (criterion as any)[k]));
        binds &&= results.length === 1 && results[0].passed === true && (criterion.method !== 'review' || (record.data.model_version===BLOCK_MODEL?!!results[0].review_ref:results[0].reviewer === 'fixture-reviewer'));
      }
      if(record.data.model_version===BLOCK_MODEL)try{g.engine.checkHostValidation(origin,v.realization,e);}catch{binds=false;}
      (binds ? matches : mismatches).push(ref);
    }
    const baseline = record.type === 'composition' ? snapshotFromRelease(g.records[record.data.baseline].data) : record.data.baseline ? snapshotFromRelease(g.records[record.data.baseline].data) : evaluation.snapshot;
    const requiredScope = record.type === 'release' && origin !== target && g.records[origin]?.type === 'composition' ? g.engine.evaluate(g.records[origin].data).scope : evaluation.scope;
    const approvals: string[] = [], rejected_approvals: string[] = [];
    for (const [ref, r] of Object.entries(g.records)) if (r.type === 'approval' && (r.data.target === candidate || record.data.approvals?.includes(ref))) {
      const a = r.data;
      const authority = a.kind === 'release' ? a.scope === null && baseline.authorities.release.includes(a.principal) : a.kind === 'scope' ? a.scope === requiredScope && baseline.authorities.scopes.some(s => s.block === a.scope && s.selectors.includes(a.principal)) : a.kind === 'guardian' ? baseline.authorities.guardians.some(s => s.item === a.scope && s.principal === a.principal) : false;
      const versionedBinding = !a.format || (a.baseline === g.records[origin]?.data.baseline && a.authority_sha256 === digest(baseline.authorities));
      (authority && versionedBinding && a.target === candidate && matches.some(v => g.records[v].data.evidence_digest === a.evidence_digest) ? approvals : rejected_approvals).push(ref);
    }
    const changesGuardian = baseline.authorities.guardians.filter(guard => { const [b,p] = guard.item.split('/'); return canonical(item(baseline.blocks[b],p)) !== canonical(item(evaluation.snapshot.blocks[b],p)); });
    const approval_coverage = ['scope','release',...changesGuardian.map(g => `guardian:${g.item}`)].map(kind => ({ kind, recorded: approvals.some(ref => { const a = g.records[ref].data; return kind.startsWith('guardian:') ? a.kind === 'guardian' && a.scope === kind.slice(9) : a.kind === kind; }) }));
    return { candidate, matching_validation: matches.sort(), mismatched_validation: mismatches.sort(), matching_approvals: approvals.sort(), mismatched_approvals: rejected_approvals.sort(), approval_coverage, publication: record.type === 'release' ? record.data.validation ? 'Published · recorded validation' : 'Bootstrap baseline · no publication evidence recorded' : 'Existing Composition · not a Release', trust:record.data.model_version===BLOCK_MODEL?'Authenticated host history':'Local fixture trust', evaluation: record.type === 'release' ? 'Retained Release snapshot' : evaluation.state, authority_coverage: isContentModel(record.data.model_version) ? 'Current authority checks unavailable' : 'Pinned baseline authority; historical approval records' };
  }
  private projectRecord(g: Generation, ref: string, type: string) {
    const r = this.record(g, ref, type), d = r.data;
    if (type === 'release') return { ref, type, ...d, status: this.evidence(g, ref) };
    if (type === 'layer') {
      const baseline = this.target(g, d.baseline).snapshot;
      return { ref, type, ...d, published: r.published, review_required: !r.published, proposed_requirement_facets: [...new Set(d.changes.filter((c: any) => c.path.startsWith('requirements.')).flatMap((c: any) => c.value.facets ?? []))].sort(), proposals: [...d.changes.map((c: any) => ({ ...c, baseline_value: item(baseline.blocks[c.block], c.path) })), ...d.acceptance.map((a: any) => ({ block: a.block, path: 'acceptance.'+a.id, value: a.criterion, expected: { kind:'absent' }, baseline_value: { exists: false } }))] };
    }
    if (type === 'realization') return { ref, type, ...Object.fromEntries(['protocol_version','model_version','target','candidate','profile_id','profile','output_tree','coverage','trust','format','checker_sha256','fixture_sha256','oracle_sha256'].filter(k => d[k] !== undefined).map(k => [k,d[k]])), files: Object.entries(d.files).map(([path,text]) => ({ path, sha256: bytesDigest(text as string), byte_length: Buffer.byteLength(text as string) })) };
    if (supportFields[type]) return { ref, type, ...Object.fromEntries(supportFields[type].filter(k => d[k] !== undefined).map(k => [k, d[k]])), authority_coverage: 'Current authority checks unavailable' };
    if (type === 'resolution') {
      const target = digest({ layer:d.layer, proposal_index:d.proposal_index, payload:d.payload });
      const baselineRef = g.records[d.layer].data.baseline;
      const base = snapshotFromRelease(g.records[baselineRef].data);
      const authority = base.authorities.scopes.find(s => s.block === d.payload.scope);
      return { ref, type, ...d, unsigned_target: target, endorsements: d.approvals.map((r: string) => { const a = g.records[r]?.data; return { ref: r, matches: a?.target === target && a?.kind === 'resolution' && a?.scope === d.payload.scope && a?.evidence_digest === null && authority?.selectors.includes(a?.principal) && (!a?.format || (a.baseline === baselineRef && a.authority_sha256 === digest(base.authorities))) }; }), rationale: d.payload.rationale ?? 'No rationale recorded in this format.' };
    }
    return { ref, type, ...d };
  }
  query(route: string, q: URLSearchParams) {
    this.authorize();
    if (this.active >= 4) problem('READ_BUSY', 503, 'Studio is busy. Try again.', true);
    this.active++;
    try {
      if (route === 'connection') return this.connection();
      const g = this.current(q.get('generation'));
      const ref = q.get('ref') ?? '', at = q.get('at') ?? '';
      if (route === 'records') {
        const type = q.get('type') ?? ''; if (!RECORD_TYPES.includes(type as any)) problem('INVALID_INPUT', 400, 'Choose a supported published record type.');
        const rows = Object.entries(g.records).filter(([,r]) => r.type === type && (!q.get('baseline') || r.data.baseline === q.get('baseline')) && (!q.get('target') || (r.data.target === q.get('target') || r.data.composition === q.get('target') || r.data.candidate === this.target(g, q.get('target')!).fingerprint))).sort(([a],[b]) => a.localeCompare(b,'en')).map(([ref,r]) => ({ ref, type, owner: r.data.owner, baseline: r.data.baseline, intent: r.data.intent ? snippet(r.data.intent) : undefined, proposed_item_count: r.type === 'layer' ? r.data.changes.length+r.data.acceptance.length : undefined, published: r.published, review_required: !r.published }));
        return this.page(g, rows, q, { route,type,baseline:q.get('baseline'),target:q.get('target') });
      }
      if (route === 'record') return this.projectRecord(g, ref, q.get('type') ?? '');
      if (route === 'evaluation') {
        const { evaluation:e, coverage } = this.evaluation(g,ref), c = g.records[ref].data;
        const competitors = c.selected.flatMap((r: string) => g.records[r].data.changes.map((change: any) => ({ ref:r, owner:g.records[r].data.owner, ...change })));
        return { ref, baseline:c.baseline, state: e.state, coverage, diagnostics:e.diagnostics, impact:e.impact, scope:e.scope, fingerprint:e.fingerprint, competing_proposals:competitors, status:this.evidence(g,ref), effective_available:e.state !== 'blocked' && coverage === 'current-policy', notice:e.state === 'blocked' ? 'No effective result shown while this candidate is blocked.' : coverage !== 'current-policy' ? 'Current authority checks unavailable.' : 'Eligible for validation. Approval and publication are separate.' };
      }
      if (route === 'diff') {
        const left = q.get('left') ?? '', right = q.get('right') ?? '', a = this.target(g,left).snapshot, b = this.target(g,right).snapshot;
        if (a.model_version !== b.model_version) problem('CROSS_MODEL',409,'These model versions cannot be compared.');
        const all = q.get('all') === 'true', rows: any[] = [];
        for (const id of [...new Set([...Object.keys(a.blocks),...Object.keys(b.blocks)])].sort()) {
          const before = a.blocks[id], after = b.blocks[id];
          if (!before || !after) { rows.push({ block:id,path:null,before:before ? {kind:'value',value:before} : {kind:'absent'},after:after ? {kind:'value',value:after} : {kind:'absent'},changed:true }); continue; }
          const paths = ['purpose','parent',...(before.description ? ['description',...new Set([...Object.keys(before.asset_refs ?? {}),...Object.keys(after.asset_refs ?? {})])].map(k=>k==='description'?k:'asset_refs.'+k) : []),...['requirements','acceptance','relationships'].flatMap(c=>[...new Set([...Object.keys((before as any)[c]),...Object.keys((after as any)[c])])].map(k=>c+'.'+k)),...['inputs','outputs','failures'].flatMap(c=>[...new Set([...Object.keys((before.contract as any)[c]),...Object.keys((after.contract as any)[c])])].map(k=>'contract.'+c+'.'+k))].sort();
          for (const path of paths) { const av=item(before,path),bv=item(after,path), changed=av.exists!==bv.exists || (av.exists && canonical(av.value)!==canonical(bv.value)); if (all || changed) rows.push({ block:id,path,before:av.exists?{kind:'value',value:av.value}:{kind:'absent'},after:bv.exists?{kind:'value',value:bv.value}:{kind:'absent'},changed }); }
        }
        const beforeAuthority = authorityItems(a), afterAuthority = authorityItems(b);
        for (const path of [...new Set([...beforeAuthority.keys(), ...afterAuthority.keys()])].sort()) {
          const before = beforeAuthority.get(path), after = afterAuthority.get(path);
          const changed = !before || !after || canonical(before.value) !== canonical(after.value);
          if (all || changed) rows.push({ kind: 'authority', block: before?.block ?? after?.block ?? null, path, before: before ? { kind: 'value', value: before.value } : { kind: 'absent' }, after: after ? { kind: 'value', value: after.value } : { kind: 'absent' }, changed });
        }
        return { left,right,model_version:a.model_version,coverage:'Block intent and pinned authority policy; current approvals and evidence are shown separately.',...this.page(g,rows,q,{route,left,right,all}) };
      }
      const target = this.target(g,at), snapshot = target.snapshot;
      const subtree = (id: string) => [...new Set(Object.values(snapshot.blocks).filter(b=>ancestors(snapshot,b.id).includes(id)).flatMap(blockFacets))].sort();
      if (route === 'blocks') {
        const text = q.get('text') ?? ''; if (text.length > 256) problem('INVALID_INPUT',400,'Search is limited to 256 characters.');
        const facets = (q.get('facets') ?? '').split(',').filter(Boolean), match = q.get('match') ?? 'direct';
        if (facets.some(f=>!FACETS.includes(f as any)) || !['direct','subtree'].includes(match)) problem('INVALID_INPUT',400,'Choose supported facets and matching mode.');
        const authority=q.get('authority') ?? '';
        const nearest=(id:string)=>ancestors(snapshot,id).map(id=>snapshot.authorities.scopes.find(s=>s.block===id)).find(Boolean);
        const rows = Object.values(snapshot.blocks).sort((a,b)=>a.id.localeCompare(b.id,'en')).filter(b=>!authority || nearest(b.id)?.selectors.includes(authority)).filter(b=>!facets.length || facets.some(f=>(match==='subtree'?subtree(b.id):blockFacets(b)).includes(f as any))).filter(b=>`${b.id} ${b.purpose} ${Object.values(b.requirements).map(r=>r.statement).join(' ')} ${Object.values(b.acceptance).map(r=>r.statement).join(' ')}`.toLowerCase().includes(text.toLowerCase())).map(b=>({ id:b.id,parent:b.parent,purpose:snippet(b.purpose),direct_facets:blockFacets(b),subtree_facets:subtree(b.id),requirements:Object.keys(b.requirements).length,ancestors:ancestors(snapshot,b.id).slice(1),matching_items:text ? [...Object.entries(b.requirements).filter(([,r])=>r.statement.toLowerCase().includes(text.toLowerCase())).map(([key])=>'requirements.'+key),...Object.entries(b.acceptance).filter(([,r])=>r.statement.toLowerCase().includes(text.toLowerCase())).map(([key])=>'acceptance.'+key)] : [] }));
        const ancestorIds = new Set(rows.flatMap(r=>r.ancestors));
        return { ...this.page(g,rows,q,{route,at,text,facets,match,authority}),ancestor_context:[...ancestorIds].sort().map(id=>({id,parent:snapshot.blocks[id].parent,purpose:snippet(snapshot.blocks[id].purpose)})),authority_options:[...new Set(snapshot.authorities.scopes.flatMap(s=>s.selectors))].sort(),facet_counts:Object.fromEntries(FACETS.map(f=>[f,Object.values(snapshot.blocks).filter(b=>(match==='subtree'?subtree(b.id):blockFacets(b)).includes(f)).length])) };
      }
      const id=q.get('id') ?? ''; if (!Object.hasOwn(snapshot.blocks,id)) return notFound(); const block=snapshot.blocks[id];
      const relations = Object.values(snapshot.blocks).flatMap(b=>Object.entries(b.relationships).filter(([,r])=>b.id===id || r.target===id).map(([key,r])=>({ kind:'relationship',source:b.id,key,target:r.target,statement:r.statement,acceptance:r.acceptance,direction:b.id===id?'outgoing':'incoming' })));
      const parents = Object.values(snapshot.blocks).filter(b=>b.parent!==null && (b.id===id || b.parent===id)).map(b=>({kind:'parent',source:b.parent!,target:b.id,key:'parent'}));
      if (route === 'relations') return this.page(g,[...parents,...relations],q,{route,at,id});
      if (route !== 'block') return notFound();
      const nearest = ancestors(snapshot,id).map(id=>snapshot.authorities.scopes.find(s=>s.block===id)).find(Boolean);
      const evidence=this.evidence(g,at);
      return { at,block,direct_facets:blockFacets(block),subtree_facets:subtree(id),ancestors:ancestors(snapshot,id).slice(1).reverse(),relationships:relations,authority:{nearest_scope:nearest,guardians:snapshot.authorities.guardians.filter(g=>g.item.startsWith(id+'/')),release:snapshot.authorities.release,write_scope:'Not available from this record'},provenance:obligations(snapshot).filter(o=>o.item.startsWith(id+'/')).map(o=>({item:o.item,contributors:target.provenance[o.item] ?? [],baseline:g.records[at].data.baseline ?? at})),status:evidence,matched_evidence:Object.fromEntries(Object.entries(block.acceptance).map(([key,c])=>[key,evidence.matching_validation.map(ref=>({ref,result:g.records[ref].data.evidence.results.find((r:any)=>['check','version','fixture','method'].every(k=>r[k]===(c as any)[k]))}))])) };
    } finally { this.active--; }
  }
  sourceInfo() { this.authorize(); return this.generation?.source ?? null; }
}
