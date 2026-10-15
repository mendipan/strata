// Public synthetic subprocess fixture. No network or actual owner files/keys.
import { AgentConnectionStore } from '../dist/src/explorer/agent-connection-store.js';
import { AgentConnections } from '../dist/src/explorer/agent-connection.js';
const chunks = []; let length = 0;
for await (const chunk of process.stdin) { length += chunk.length; if (length > 8192) throw new Error('Bounded fixture input required.'); chunks.push(chunk); }
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const counts = { contextLoads: 0, dispatches: 0 };
globalThis.fetch = async () => { throw new Error('External transport unavailable in fixture.'); };
const store = new AgentConnectionStore(input.directory, input.scope);
let guardArmed = false, invalidationFired = false;
const authority = { async current() {
  if (guardArmed && !invalidationFired) { invalidationFired = true; manager.changed(); }
  return input.owner;
} };
const manager = new AgentConnections(store, {
  source: { async current() { return input.source; } }, targets: { async current() { return input.approval; } },
  access: {
    async current() { return input.metadata; },
    async context() {
      counts.contextLoads++;
      if (input.mode === 'sync-headers') guardArmed = true;
      return { authentication: {
        async headers() { return new Headers({ 'x-synthetic-proof': 'public-fixture-only' }); },
        async verify() { return { subject: input.approval.target.expected_subject, expires_at: input.metadata.valid_until }; },
      }, transport: async () => {
        counts.dispatches++;
        if (input.mode === 'pending') { process.stdout.write(JSON.stringify({ phase: 'dispatched', counts }) + '\n'); return new Promise(() => {}); }
        if (input.mode === 'sync-verify') guardArmed = true;
        const target = input.approval.target, now = Date.now();
        return Response.json({ format: 'strata-agent-discovery/1', service_id: target.service_id, instance_id: target.instance_id,
          binding: target.binding, authenticated_subject: target.expected_subject, discovered_at: new Date(now).toISOString(),
          valid_until: new Date(now + 60_000).toISOString(), declaration_sha256: target.declaration_sha256, advertised_features: ['engine:approve'] });
      } };
    },
  },
});
const hold = input.mode === 'pending' || input.mode === 'lease' ? setInterval(() => {}, 1000) : undefined;
try {
  if (input.mode === 'lease') await store.transaction(async () => { process.stdout.write(JSON.stringify({ phase: 'leased' }) + '\n'); await new Promise(() => {}); });
  else if (input.mode === 'status') process.stdout.write(JSON.stringify({ status: await manager.status(authority), counts }) + '\n');
  else if (input.mode === 'outcome') process.stdout.write(JSON.stringify({ outcome: await manager.outcome(authority, input.request.request_id), status: await manager.status(authority), counts }) + '\n');
  else {
    const result = await manager.action(authority, input.request);
    // Allow late rejection delivery before asserting strict process survival.
    if (input.mode.startsWith('sync-')) await new Promise(resolve => setTimeout(resolve, 25));
    process.stdout.write(JSON.stringify({ result, counts, invalidation_fired: invalidationFired }) + '\n');
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? 'FIXTURE_FAILURE' }, counts }) + '\n'); process.exitCode = 1;
} finally { if (hold) clearInterval(hold); }
