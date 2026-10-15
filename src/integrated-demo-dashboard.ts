import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { OperatorPromptPacket, OperatorDecisionAction } from './integrated-demo-operator-reply.js';
import { integratedDemoSelectionReviewHtml } from './integrated-demo-review.js';
import { DemoRunPresentation, type RunSourceMode } from './demo-run-presentation.js';
import { DEMO_RUN_HTML, DEMO_RUN_JS } from './demo-run-workbench.js';

type Decision = { action: OperatorDecisionAction; reason: string; capture_method: 'local-browser' };
export type DemoDashboardControls = { state(): unknown; handle(action: string, input: any): Promise<unknown> };

// No provider access and no filesystem serving. The capability stays in the URL
// fragment/sessionStorage, never in HTTP request paths or persisted run evidence.
export async function createDemoDashboard(runId: string, stop: () => void, controls?: DemoDashboardControls,
  options: { source_mode?: RunSourceMode; replay?: { chapters: { view: any }[]; [key: string]: any } } = {}) {
  const capability = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  let origin = '', pending: { packet: OperatorPromptPacket; settle(value?: Decision): void } | undefined;
  let finished = false, lastEventAt: string | null = null, reviewHtml = '';
  const events: unknown[] = [];
  let projection = new DemoRunPresentation(runId, options.source_mode), responseReceived: any = null;
  const history: any[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (code: number, value: unknown, type = 'application/json') => {
      response.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
      response.end(type === 'application/json' ? JSON.stringify(value) : String(value));
    };
    if (request.headers.host !== origin.replace('http://', '')) return send(403, { error: 'Host refused' });
    if (request.method === 'GET' && request.url === '/') return send(200, DEMO_RUN_HTML, 'text/html');
    if (request.method === 'GET' && request.url === '/app.js') return send(200, DEMO_RUN_JS, 'text/javascript');
    if (request.headers.authorization !== 'Bearer ' + capability) return send(403, { error: 'Open the private browser link printed in your terminal.' });
    if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Origin refused' });
    if (request.method === 'GET' && request.url === '/state')
      return send(200, { run_id: runId, finished, last_event_at: lastEventAt, events, packet: pending?.packet ?? null, review_html: reviewHtml,
        view: options.replay?.chapters[0].view ?? projection.snapshot(), history, response_received: responseReceived,
        replay: !!options.replay,
        ...(controls ? { lab: controls.state() } : {}) });
    if (request.method === 'GET' && request.url === '/replay' && options.replay) return send(200, options.replay);
    if (request.method === 'POST' && (options.replay || ['recorded-replay', 'imported-unverified'].includes(options.source_mode ?? ''))) return send(409, { error: 'Read-only source; no consent or run controls accepted.' });
    if (request.method !== 'POST' || !['/decision', '/stop', ...(controls ? ['/lab/check', '/lab/begin', '/lab/fresh', '/lab/signin'] : [])].includes(request.url ?? '')) return send(404, { error: 'Not found' });
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(403, { error: 'Origin or content type refused' });
    try {
      let bytes = 0, body = '';
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8192) return send(413, { error: 'Request too large' }); body += chunk.toString(); }
      const input = JSON.parse(body);
      if (controls && request.url?.startsWith('/lab/')) {
        try { return send(200, await controls.handle(request.url.slice(5), input)); }
        catch (error: any) { return send(409, { error: error.message ?? 'This action is currently unavailable.' }); }
      }
      if (input.run_id !== runId || finished) return send(409, { error: 'Run is not accepting input' });
      if (request.url === '/stop') { pending?.settle(); stop(); return send(200, { accepted: true }); }
      const packet = pending?.packet;
      if (!packet || input.packet_digest !== packet.packet_digest || input.phase !== packet.phase || Date.now() >= packet.expires_at ||
        !packet.allowed_actions.includes(input.action) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2048)
        return send(409, { error: 'Decision is invalid, expired, or already submitted. Refresh the pending packet.' });
      responseReceived = { run_id: runId, packet_digest: packet.packet_digest, phase: packet.phase };
      pending!.settle({ action: input.action, reason: input.reason.trim(), capture_method: 'local-browser' });
      return send(200, { accepted: true });
    } catch { return send(400, { error: 'Invalid request' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return {
    url: origin + '/#' + capability,
    resetRun(id: string) {
      if (pending) throw new Error('Finish the pending decision before preparing a new run.');
      runId = id; finished = false; lastEventAt = null; reviewHtml = ''; events.length = 0;
      projection = new DemoRunPresentation(id, options.source_mode); history.length = 0; responseReceived = null;
    },
    async emit(record: any) {
      lastEventAt = new Date().toISOString();
      projection.accept(record, lastEventAt);
      if (record.type === 'release-verified' || record.type === 'measurement-verified') {
        history.push(projection.snapshot()); if (history.length > 16) history.shift();
      }
      // Event list is secondary and allowlisted too; raw outcomes never enter it.
      const summary: any = Object.fromEntries(['type', 'sequence', 'kind', 'source', 'phase', 'actor', 'assigned_revision', 'code', 'startup_failed'].filter(k => record[k] !== undefined).map(k => [k, record[k]]));
      if (summary.type === 'cleanup-verified') {
        const safe = projection.snapshot().cleanup;
        summary.cleanup = { cleanup: safe.checks, counters: safe.counters };
      }
      events.push({ ...summary, observed_at: lastEventAt }); if (events.length > 160) events.shift();
    },
    decide(packet: OperatorPromptPacket, signal: AbortSignal): Promise<Decision> {
      if (options.replay || ['recorded-replay', 'imported-unverified'].includes(options.source_mode ?? '') || pending || finished || packet.run_id !== runId || signal.aborted || Date.now() >= packet.expires_at) return Promise.reject(new Error('Decision unavailable.'));
      // Existing canonical proposal comparison; rendering failure must not select a default.
      reviewHtml = packet.phase === 'selection' ? integratedDemoSelectionReviewHtml(packet) : '';
      projection.review(packet); history.push(projection.snapshot()); if (history.length > 16) history.shift();
      return new Promise((resolve, reject) => {
        const interrupted = () => pending?.settle();
        const timer = setTimeout(interrupted, Math.max(1, packet.expires_at - Date.now()));
        pending = { packet: structuredClone(packet), settle(value) {
          clearTimeout(timer); signal.removeEventListener('abort', interrupted); pending = undefined; reviewHtml = '';
          if (value) resolve(value); else reject(new Error('Decision interrupted or expired; no default selected.'));
        } };
        signal.addEventListener('abort', interrupted, { once: true });
        if (signal.aborted) interrupted();
      });
    },
    finish() { pending?.settle(); finished = true; },
    async close() { pending?.settle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
