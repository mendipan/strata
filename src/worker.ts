import { Agent, getAgentByName } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import { Engine } from './core.js';
import { canonical, digest, bytesDigest, fail, StrataError, type Records } from './model.js';
import { executeAuthorized, MUTATIONS } from './service.js';
import { FixtureIssuer, validateEnvelope, auditEvent, MAX_REQUEST_BYTES, type SecurityContext } from './security.js';
import type { ArtifactStore } from './artifacts.js';
import { publishPrepared, type Registry, type LayerContext, type PreparedLayer } from './publication.js';
import { commitReferences } from './recovery.js';

type Env = { PROJECT: DurableObjectNamespace; LAYERS: DurableObjectNamespace; LOCAL_ARTIFACTS: DurableObjectNamespace<LocalArtifactStore>; LOCAL_FIXTURES: string };
type Options = { dry_run: boolean; idempotency_key?: string; fault?: 'after-stage' | 'after-commit' };
export type Span = { actor: string; phase: 'hash' | 'storage-io' | 'publication'; start_ms: number; end_ms: number };
type RPC = {
  operation(command: string, input: any, context: SecurityContext, options: Options): Promise<any>;
  layerContext(command: string, input: any, context: SecurityContext, options: Options): Promise<LayerContext & { memo?: any }>;
  commitLayer(prepared: PreparedLayer, command: string, input: any, options: Options, result: any, context: SecurityContext): Promise<any>;
  recordDenial(context: SecurityContext | null, command: string, code: string): Promise<void>;
};
// Avoid recursive Agent<Env> type inference at the binding boundary.
const namedAgent = getAgentByName as unknown as (namespace: DurableObjectNamespace, name: string) => Promise<RPC>;
const ISSUER = new FixtureIssuer();
let ingress = 0;
const failure = (error: unknown) => {
  const e = error instanceof StrataError ? error : new StrataError('INTERNAL_ERROR', 1, 'Local broker execution failed.');
  return { ok: false, error: { code: e.code, exit: e.exit, message: e.message, details: e.details } };
};
const artifact = (env: Env, hash: string) => env.LOCAL_ARTIFACTS.get(env.LOCAL_ARTIFACTS.idFromName('local-artifacts-' + hash.slice(0, 2)));
async function readEntries(env: Env, entries: Registry['entries']): Promise<Records> {
  const records: Records = {}, refs = Object.entries(entries);
  for (let i = 0; i < refs.length; i += 32) await Promise.all(refs.slice(i, i + 32).map(async ([ref, entry]) => {
    const body = await artifact(env, entry.hash).get(entry.hash) ?? await env.LOCAL_ARTIFACTS.get(env.LOCAL_ARTIFACTS.idFromName('local-artifacts')).get(entry.hash);
    if (!body || bytesDigest(body) !== entry.hash) fail('STORE_UNAVAILABLE', 9, 'Registry points to an absent or corrupt artifact.');
    records[ref] = { type: entry.type, published: entry.published, data: JSON.parse(body) };
  }));
  return records;
}
export class LocalArtifactStore extends DurableObject<Env> implements ArtifactStore {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, body TEXT NOT NULL)'); }
  async stage(hash: string, body: string, actor: string): Promise<Span> {
    if (bytesDigest(body) !== hash) fail('ARTIFACT_DIGEST', 9, 'Artifact digest does not match its bytes.');
    const existing = await this.get(hash);
    if (existing !== null && existing !== body) fail('ARTIFACT_COLLISION', 9, 'Immutable artifact address collision.');
    // Timestamp persistence INSIDE this DO, excluding the caller/RPC queue.
    const start_ms = Date.now();
    await this.ctx.storage.put('object:' + hash, body);
    await this.ctx.storage.sync();
    return { actor, phase: 'storage-io', start_ms, end_ms: Date.now() };
  }
  async put(hash: string, body: string) { await this.stage(hash, body, 'project'); }
  async get(hash: string) { return await this.ctx.storage.get<string>('object:' + hash) ?? this.ctx.storage.sql.exec<{ body: string }>('SELECT body FROM objects WHERE hash = ?', hash).toArray()[0]?.body ?? null; }
}
export class ProjectAgent extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS registry (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`;
  }
  registry(): Registry {
    const row = this.sql<{ body: string }>`SELECT body FROM registry WHERE id = 1`[0];
    return row ? JSON.parse(row.body) : { entries: {}, heads: {} };
  }
  audit(context: SecurityContext | null, command: string, operationId: string, outcome: 'allowed' | 'denied' | 'committed', reason: string | null = null, refs: string[] = []) {
    if (this.sql<{ count: number }>`SELECT count(*) AS count FROM audit`[0].count >= 20000) fail('AUDIT_UNAVAILABLE', 9, 'The bounded local audit ledger is full.');
    const event = auditEvent(context, command, operationId, outcome, reason); event.references = refs.slice(0, 20);
    const body = JSON.stringify(event); this.sql`INSERT INTO audit (body) VALUES (${body})`;
  }
  async recordDenial(context: SecurityContext | null, command: string, code: string) { this.audit(context, command, crypto.randomUUID(), 'denied', code); }
  memo(command: string, input: any, context: SecurityContext, options: Options) {
    ISSUER.authorize(context, command, input); const principal = context.principal_id;
    const requestDigest = digest({ command, input, principal });
    this.audit(context, command, requestDigest.slice(0, 24), 'allowed');
    const key = MUTATIONS.has(command) && options.idempotency_key ? context.tenant_id + ':' + context.project_id + ':' + principal + ':' + options.idempotency_key : null;
    if (key && !options.dry_run) {
      const row = this.sql<{ digest: string; result: string }>`SELECT digest, result FROM requests WHERE key = ${key}`[0];
      if (row && row.digest !== requestDigest) fail('IDEMPOTENCY_CONFLICT', 5, 'Idempotency key already binds different input.');
      if (row) return { key, requestDigest, result: { ...JSON.parse(row.result), reused: true } };
    }
    return { key, requestDigest, result: null };
  }
  save(registry: Registry, memo: ReturnType<ProjectAgent['memo']>, result: any, context: SecurityContext, command: string, input: any) {
    ISSUER.assertLive(context);
    this.audit(context, command, result.operation_id, 'committed', null, commitReferences(command, input, result));
    const body = canonical(registry);
    this.sql`INSERT OR REPLACE INTO registry (id, body) VALUES (1, ${body})`;
    if (memo.key) this.sql`INSERT INTO requests (key, digest, result) VALUES (${memo.key}, ${memo.requestDigest}, ${JSON.stringify(result)})`;
  }
  async layerContext(command: string, input: any, context: SecurityContext, options: Options): Promise<any> {
    try {
    const principal = context.principal_id;
    const memo = this.memo(command, input, context, options);
    if (memo.result) return { entries: {}, head: null, memo: memo.result };
    const registry = this.registry(), id = input.record?.id ?? input.ref?.split('@')[0], head = registry.heads[id] ?? null;
    if (head && head.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'This Layer belongs to another principal.');
    const refs: string[] = command === 'layer.publish' ? [input.ref] : [input.record?.baseline, input.previous, ...(input.record?.read_set ?? []).map((r: any) => r.layer)].filter(Boolean);
    if(input.authoring_review)refs.push(input.authoring_review);
    for(const [ref,entry]of Object.entries(registry.entries))if(['mediation-installation','selection-policy','selection-grant'].includes(entry.type))refs.push(ref);
    const entries: Registry['entries'] = {};
    for (const ref of refs) {
      const entry = registry.entries[ref];
      if (!entry) fail('REF_NOT_FOUND', 3, 'Pinned reference was not found.', { ref });
      entries[ref] = entry;
    }
    return { entries, head };
    } catch (error) { return failure(error); }
  }
  async commitLayer(prepared: PreparedLayer, command: string, input: any, options: Options, result: any, context: SecurityContext): Promise<any> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (prepared.principal !== context.principal_id) fail('OWNER_FORBIDDEN', 4, 'Prepared identity does not match the server context.');
        const memo = this.memo(command, input, context, options);
        if (memo.result) return memo.result;
        if (options.dry_run) return result;
        if (options.fault === 'after-stage') fail('INJECTED_STAGE_FAILURE', 9, 'Fixture failure after artifact staging, before publication.');
        const start_ms = Date.now();
        this.ctx.storage.transactionSync(() => this.save(publishPrepared(this.registry(), prepared), memo, result, context, command, input));
        if (options.fault === 'after-commit') fail('INJECTED_RESPONSE_LOSS', 9, 'Fixture response lost after publication committed.');
        return { ...result, trace: [...(result.trace ?? []), { actor: prepared.id, phase: 'publication', start_ms, end_ms: Date.now() }] };
      } catch (error) { return failure(error); }
    });
  }
  async operation(command: string, input: any, context: SecurityContext, options: Options): Promise<any> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const principal = context.principal_id;
        const memo = this.memo(command, input, context, options);
        // Cached mutations also reload the current records and recheck authorization.
        const registry = this.registry();
        const selected = command === 'inspect' && input.ref && !['composition', 'block'].includes(input.type) && !Object.values(registry.entries).some(e=>e.type==='mediation-installation')
          ? (registry.entries[input.ref] ? { [input.ref]: registry.entries[input.ref] } : {}) : registry.entries;
        const engine = new Engine(await readEntries(this.env, selected), registry.heads,{projectId:context.project_id,checkerBackend:'none'});
        if (memo.result) { ISSUER.authorize(context, command, input, engine); return memo.result; }
        const contexts = registry.contexts ?? {};
        const before = new Set(Object.keys(engine.records));
        const data = executeAuthorized(engine, command, input, context, ISSUER, options.dry_run, contexts);
        const created = options.dry_run ? [] : Object.keys(engine.records).filter(ref => !before.has(ref));
        const result = { ok: true, data, created, operation_id: digest({ command, input, principal }).slice(0, 24), dry_run: options.dry_run };
        if (options.dry_run || !MUTATIONS.has(command)) return result;
        const entries: Registry['entries'] = {};
        for (const [ref, record] of Object.entries(engine.records)) {
          const body = canonical(record.data), hash = bytesDigest(body);
          if (registry.entries[ref]?.hash !== hash) await artifact(this.env, hash).put(hash, body);
          entries[ref] = { type: record.type, hash, published: record.published };
        }
        if (options.fault === 'after-stage') fail('INJECTED_STAGE_FAILURE', 9, 'Fixture failure after artifact staging, before publication.');
        ISSUER.authorize(context, command, input, engine);
        this.ctx.storage.transactionSync(() => this.save({ ...registry, entries, heads: engine.ownerHeads, contexts }, memo, result, context, command, input));
        if (options.fault === 'after-commit') fail('INJECTED_RESPONSE_LOSS', 9, 'Fixture response lost after publication committed.');
        return result;
      } catch (error) { return failure(error); }
    });
  }
}
export class LayerAgent extends Agent<Env> {
  async onStart() { this.sql`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)`; }
  async operation(command: string, input: any, security: SecurityContext, options: Options): Promise<any> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        ISSUER.authorize(security, command, input); const principal = security.principal_id;
        if (!['layer.create', 'layer.revise', 'layer.publish'].includes(command)) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown Layer operation.');
        const identity = this.sql<{ owner: string }>`SELECT owner FROM identity WHERE id = 1`[0];
        if (identity && identity.owner !== principal) fail('OWNER_FORBIDDEN', 4, 'This Agent instance belongs to another Layer owner.');
        const project = await namedAgent(this.env.PROJECT, 'strata-project');
        const context = await project.layerContext(command, input, security, options);
        if ((context as any).ok === false) return context;
        if (context.memo) return context.memo;
        const id = input.record?.id ?? input.ref.split('@')[0];
        const records = await readEntries(this.env, context.entries);
        const engine = new Engine(records, context.head ? { [id]: context.head } : {},{projectId:security.project_id,checkerBackend:'none'});
        const before = new Set(Object.keys(records)), data = executeAuthorized(engine, command, input, security, ISSUER, options.dry_run);
        if (options.dry_run) return { ok: true, data, created: [], operation_id: digest({ command, input, principal }).slice(0, 24), dry_run: true, trace: [] };
        const record = engine.records[data.ref], body = canonical(record.data), start_ms = Date.now();
        // Native async hashing and immutable persistence are independent of the project lock.
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), b => b.toString(16).padStart(2, '0')).join('');
        const trace: Span[] = [{ actor: id, phase: 'hash', start_ms, end_ms: Date.now() }];
        if (context.entries[data.ref]?.hash !== hash) trace.push(await artifact(this.env, hash).stage(hash, body, id));
        const result = { ok: true, data, created: before.has(data.ref) ? [] : [data.ref], operation_id: digest({ command, input, principal }).slice(0, 24), dry_run: options.dry_run, trace };
        const committed = await project.commitLayer({ id, principal, expected_head: context.head, refs: context.entries, ref: data.ref, entry: { type: record.type, hash, published: record.published }, record, head: engine.ownerHeads[id] ?? null }, command, input, options, result, security);
        if (committed.ok && !identity) this.sql`INSERT INTO identity (id, owner) VALUES (1, ${principal})`;
        return committed;
      } catch (error) { return failure(error); }
    });
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (env.LOCAL_FIXTURES !== 'true' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return new Response('Local prototype only', { status: 403 });
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ local: true, model: 'strata/0.1-facets-experimental' });
    if (url.pathname !== '/v1/operation' || request.method !== 'POST' || request.headers.get('origin')) return new Response('Not found', { status: 404 });
    let security: SecurityContext | null = null, command = 'invalid', admitted = false;
    try {
      security = ISSUER.resolve(request.headers.get('x-strata-session') ?? '', request.headers.get('x-strata-project') ?? ISSUER.projectId);
      if (ingress >= 64) fail('QUEUE_FULL', 9, 'The bounded local operation queue is full.');
      ingress++; admitted = true;
      const reader = request.body?.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
      if (!reader) fail('INVALID_ARGUMENT', 2, 'Expected one JSON operation.');
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_REQUEST_BYTES) fail('INVALID_ARGUMENT', 2, 'Request exceeds the local byte limit.'); parts.push(part.value); }
      } finally { await reader.cancel(); }
      const raw = new Uint8Array(bytes); let offset = 0; for (const part of parts) { raw.set(part, offset); offset += part.byteLength; }
      const body: any = validateEnvelope(new TextDecoder('utf-8', { fatal: true }).decode(raw)); command = body.command;
      ISSUER.authorize(security, command, body.input); const principal = security.principal_id;
      const options: Options = { dry_run: body.options?.dry_run === true, idempotency_key: body.options?.idempotency_key, fault: body.options?.fault };
      if (options.fault && principal !== 'bootstrap') fail('OWNER_FORBIDDEN', 4, 'Fault injection belongs to the local bootstrap fixture only.');
      let result: any;
      if (body.command.startsWith('layer.') && body.command !== 'layer.restore' && !options.dry_run) {
        const layerId = body.input?.record?.id ?? body.input?.ref?.split('@')[0];
        if (!layerId || !/^[A-Za-z0-9_.-]+$/.test(layerId)) fail('INVALID_ARGUMENT', 2, 'Layer identity is required.');
        result = await (await namedAgent(env.LAYERS, layerId)).operation(body.command, body.input, security, options);
      } else result = await (await namedAgent(env.PROJECT, 'strata-project')).operation(body.command, body.input, security, options);
      if (!result.ok) { try { await (await namedAgent(env.PROJECT, 'strata-project')).recordDenial(security, command, result.error.code); } catch {} }
      return Response.json(result);
    } catch (error) {
      const result = failure(error);
      try { await (await namedAgent(env.PROJECT, 'strata-project')).recordDenial(security, command, result.error.code); } catch {}
      return Response.json(result);
    } finally { if (admitted) ingress--; }
  }
} satisfies ExportedHandler<Env>;
