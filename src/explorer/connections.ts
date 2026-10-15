import { z } from 'zod';
import { canonical } from '../model.js';
import { ExplorerError, problem } from './contract.js';
import { ExplorerReader } from './read.js';

export const SETTINGS_FORMAT = 'strata-explorer-settings/1';
const actionSchema = z.object({
  action: z.enum(['select', 'connect', 'disconnect', 'test']),
  connection_id: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ConnectionAction = z.infer<typeof actionSchema>;
export type ConfiguredConnection = {
  reader: ExplorerReader;
  provider: 'sample' | 'artifacts-rest' | 'local-broker' | 'unavailable';
  // Availability only. Never return the credential or its environment reference.
  authenticationAvailable?: () => boolean;
};
const capabilities = Object.freeze({ read: true, refresh: true, write: false, propose: false, publish: false, approve: false, validate: false, agent_chat: false });
const messages: Record<string, string> = {
  SOURCE_AUTH: 'Existing host authentication or source authorization needs attention.',
  SOURCE_BINDING: 'The configured project or repository binding could not be verified.',
  SOURCE_UNAVAILABLE: 'The configured source could not be reached. You can retry the read test.',
  READ_SESSION_LIMIT: 'The authorized read session budget is exhausted. The owner must supply a new bounded session.',
  READ_BUDGET_UNAVAILABLE: 'Protected read accounting needs authenticated operator reconciliation.',
  READ_LIMIT: 'This project exceeds the Studio read limit.',
  CORRUPT_DATA: 'Project records could not be verified.',
  CONNECTION_NOT_READY: 'The owner must configure a trusted repository connection in the local host.',
  CONNECTION_CHANGED: 'The connection changed. Refresh settings before trying again.',
  REFRESH_BUSY: 'A read verification is already in progress. Refresh status before trying again.',
};
function safeError(error: unknown) {
  const code = error instanceof ExplorerError && Object.hasOwn(messages, error.code) ? error.code : 'CORRUPT_DATA';
  return { code, message: messages[code], retryable: ['SOURCE_UNAVAILABLE', 'REFRESH_BUSY'].includes(code) };
}

// A local session catalog, not another repository. Every entry shares the same
// immutable repository/project/model binding. Only the owner can supply readers.
export class ExplorerConnections {
  private readonly entries: ConfiguredConnection[];
  private selected: string;
  private connected = true;
  private revision = 0;
  private busy = false;
  private operation?: AbortController;
  private errors = new Map<string, ReturnType<typeof safeError>>();
  private tested = new Map<string, { at: string; outcome: 'passed' | 'failed' }>();
  constructor(entries: ConfiguredConnection[], private readonly timeoutMs = 10000) {
    if (!entries.length || entries.length > 8 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) problem('INVALID_INPUT', 400, 'Invalid host connection catalog.');
    const first = entries[0].reader.source.connection;
    const binding = (r: ExplorerReader) => canonical({ project_id: r.source.connection.project_id, model_version: r.source.connection.model_version, repository_identity: r.source.connection.repository_identity ?? null });
    const ids = entries.map(e => e.reader.source.connection.connection_id);
    if (new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(id)) || entries.some(e => !['sample', 'artifacts-rest', 'local-broker', 'unavailable'].includes(e.provider) || binding(e.reader) !== binding(entries[0].reader))) problem('SOURCE_BINDING', 403, 'Host connections must share one project, model and repository.');
    this.entries = entries.map(e => ({ ...e }));
    this.selected = first.connection_id;
    this.connected = entries[0].provider !== 'unavailable';
  }
  private entry(id = this.selected) {
    const entry = this.entries.find(e => e.reader.source.connection.connection_id === id);
    if (!entry) problem('INVALID_INPUT', 400, 'Choose a host-configured connection.');
    return entry!;
  }
  get selectedReader() { return this.entry().reader; }
  reader() {
    if (!this.connected) problem('CONNECTION_DISCONNECTED', 409, 'The repository connection is disconnected. Reconnect in settings.');
    return this.selectedReader;
  }
  status() {
    const connections = this.entries.map(entry => {
      const c = entry.reader.source.connection, selected = c.connection_id === this.selected;
      let snapshot: ReturnType<ExplorerReader['connection']> | undefined;
      let error = this.errors.get(c.connection_id) ?? null;
      try { snapshot = entry.reader.connection(); }
      catch (failure) { error = safeError(failure); }
      if (snapshot?.ready && !snapshot.error) { error = null; this.errors.delete(c.connection_id); }
      let authentication = entry.provider === 'sample' ? 'not-required' : 'unknown';
      try { if (entry.authenticationAvailable) authentication = entry.authenticationAvailable() ? 'available' : 'missing'; }
      catch { authentication = 'missing'; }
      if (authentication === 'missing') error = safeError(new ExplorerError('SOURCE_AUTH', 403, ''));
      if (!error && snapshot?.error) error = safeError(new ExplorerError(snapshot.error.code, 503, ''));
      const ready = selected && this.connected && snapshot?.ready === true && !error;
      const readable = selected && this.connected && snapshot?.ready === true && (!error || error.code === 'SOURCE_UNAVAILABLE');
      const state = entry.provider === 'unavailable' ? 'unavailable' : !selected || !this.connected ? 'disconnected' : error ? (error.code === 'SOURCE_AUTH' ? 'denied' : snapshot?.source?.freshness === 'stale-network' ? 'stale' : 'error') : ready ? 'read-only' : 'unverified';
      return {
        connection_id: c.connection_id, display_name: c.display_name, provider: entry.provider,
        selected, connected: selected && this.connected, configured: entry.provider !== 'unavailable', state,
        binding: { project_id: c.project_id, model_version: c.model_version, repository_identity: c.repository_identity ?? null },
        authentication, capabilities: { ...capabilities, read: !!readable, refresh: entry.provider !== 'unavailable' },
        verification: snapshot?.source ? { registry_kind: snapshot.source.registry_kind, registry_generation: snapshot.source.registry_generation, verified_at: snapshot.source.verified_at, freshness: snapshot.source.freshness } : null,
        last_test: this.tested.get(c.connection_id) ?? null, error,
      };
    });
    return {
      format: SETTINGS_FORMAT, revision: this.revision, selected_connection_id: this.selected, busy: this.busy, connections,
      providers: [
        { id: 'sample', label: 'Synthetic sample', supported: true, configured: this.entries.some(e => e.provider === 'sample'), access: 'read-only' },
        { id: 'artifacts-rest', label: 'Cloudflare Artifacts API', supported: true, configured: this.entries.some(e => e.provider === 'artifacts-rest'), access: 'read-only' },
        { id: 'custom-endpoint', label: 'Custom endpoint', supported: false, configured: false, access: 'unavailable' },
      ],
      agent: {
        sdk: 'Cloudflare Agents SDK', sdk_state: 'implemented-in-source', service_state: 'unavailable', protocol: null, agent_chat: false,
        operations: 'Existing Strata CLI and broker workflow',
        setup_requirement: 'The owner must supply an authenticated agent bridge bound to this same repository, project, model and principal policy before Studio can call an agent. No agent protocol or chat service is configured.',
        semantics: 'SDK operations use Strata ownership, exact revisions, proposals, validation and authority checks. Connecting Studio grants no authoring, publication, approval or execution permission.',
      },
    };
  }
  async action(input: unknown) {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) problem('INVALID_INPUT', 400, 'Settings accept only an action, host connection ID and current revision.');
    const action = parsed.data, entry = this.entry(action.connection_id);
    if (action.revision !== this.revision) problem('CONNECTION_CHANGED', 409, messages.CONNECTION_CHANGED, true);
    if (action.action === 'disconnect' && action.connection_id !== this.selected) problem('INVALID_INPUT', 400, 'Disconnect the selected connection only.');
    if (action.action === 'disconnect' || action.action === 'select') {
      this.operation?.abort();
      for (const e of this.entries) e.reader.invalidate();
      this.connected = false; this.selected = action.connection_id; this.revision++;
      return this.status();
    }
    if (this.busy) problem('REFRESH_BUSY', 409, 'A connection test is already in progress.', true);
    if (entry.provider === 'unavailable') problem('CONNECTION_NOT_READY', 409, messages.CONNECTION_NOT_READY);
    if (action.connection_id !== this.selected) problem('INVALID_INPUT', 400, 'Select the connection before testing or reconnecting.');
    const reconnect = action.action === 'connect', wasConnected = this.connected;
    this.busy = true;
    const operation = new AbortController(); this.operation = operation;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const signal = AbortSignal.any([operation.signal, deadline.signal]);
    const revision = this.revision;
    try {
      if (entry.authenticationAvailable && !entry.authenticationAvailable()) problem('SOURCE_AUTH', 403, messages.SOURCE_AUTH);
      await entry.reader.refresh({ signal });
      if (revision !== this.revision || operation.signal.aborted) problem('CONNECTION_CHANGED', 409, messages.CONNECTION_CHANGED, true);
      this.errors.delete(action.connection_id);
      this.tested.set(action.connection_id, { at: new Date().toISOString(), outcome: 'passed' });
      this.connected = reconnect || wasConnected;
    } catch (failure) {
      if (revision !== this.revision || operation.signal.aborted) problem('CONNECTION_CHANGED', 409, messages.CONNECTION_CHANGED, true);
      if (failure instanceof ExplorerError && failure.code === 'REFRESH_BUSY') throw failure;
      this.errors.set(action.connection_id, safeError(failure));
      this.tested.set(action.connection_id, { at: new Date().toISOString(), outcome: 'failed' });
      if (reconnect) this.connected = false;
    } finally {
      clearTimeout(timer);
      if (!this.connected) entry.reader.invalidate();
      this.busy = false; this.operation = undefined;
    }
    this.revision++;
    return this.status();
  }
}

export function defaultConnections(reader: ExplorerReader) {
  const c = reader.source.connection;
  return new ExplorerConnections([{ reader, provider: c.repository_identity ? 'artifacts-rest' : c.connection_id === 'unconfigured' ? 'unavailable' : 'sample' }]);
}
