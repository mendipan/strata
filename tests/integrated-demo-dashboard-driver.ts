// Child of offline production-operator tests only. No live consent or provider.
import { readFile } from 'node:fs/promises';
import { runDemoOperatorCli } from '../scripts/integrated-demo-operator.js';
import { createDemoDashboard } from '../src/integrated-demo-dashboard.js';
const grant = JSON.parse(await readFile(process.argv[3], 'utf8'));
const controller = new AbortController();
const dashboard = await createDemoDashboard(grant.target.run_id, () => controller.abort());
const url = new URL(dashboard.url);
let priorSelection: unknown;
try {
  await runDemoOperatorCli(process.argv.slice(2), { signal: controller.signal, emit: record => dashboard.emit(record),
    ...(grant.format === 'strata.integrated-demo-activation-grant/2' ? { confirmed_grant_sha256: grant.grant_sha256 } : {}),
    ...(grant.format === 'strata.integrated-demo-activation-grant/3' ? { browser_approval: { action: 'begin-demo' as const, grant_sha256: grant.grant_sha256 } } : {}),
    decide: async (packet, signal) => {
      const decision = dashboard.decide(packet, signal);
      if (priorSelection && packet.phase === 'selection') {
        const stale = await fetch(url.origin + '/decision', { method: 'POST', headers: { authorization: 'Bearer ' + url.hash.slice(1),
          origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(priorSelection) });
        if (stale.ok) throw new Error('Stale first selection was accepted for repaired proposal');
      }
      const input = { run_id: packet.run_id, phase: packet.phase, packet_digest: packet.packet_digest,
        action: packet.phase === 'selection' ? (process.env.STRATA_OPERATOR_TEST_SCENARIO === 'browser-repair' ? '1200' : '900') : 'approve-release',
        reason: 'SYNTHETIC TEST browser choice, no human consent.' };
      const response = await fetch(url.origin + '/decision', { method: 'POST', headers: { authorization: 'Bearer ' + url.hash.slice(1),
        origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error('Synthetic browser decision failed');
      if (packet.phase === 'selection') priorSelection = input;
      return decision;
    } });
} catch (error) { console.error(error); process.exitCode = 7; }
finally { dashboard.finish(); await dashboard.close(); }
