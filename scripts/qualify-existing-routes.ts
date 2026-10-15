import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifyExistingRoute, type ExistingRoute } from '../src/qualification/existing-routes.js';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') { console.log('Fixed local existing-route qualification: demo --route incremental|reconstruct_declared_scope --output NEW_DIRECTORY\nUses only new synthetic Git/intent fixtures, local fixture roles and existing commands. No arbitrary app inputs, hosted activation, automatic adoption-delivery bridge or completion.'); return; }
  if (args.length !== 5 || args[0] !== 'demo' || args[1] !== '--route' || args[3] !== '--output' || !['incremental', 'reconstruct_declared_scope'].includes(args[2])) throw new Error('Use --help.');
  const root = path.resolve(args[4]), report = await qualifyExistingRoute(args[2] as ExistingRoute, root);
  console.log(JSON.stringify({ status: report.status, route: report.route, report: path.join(root, 'report.json'), delivery: report.delivery?.state, host_closed: report.host_closed, reconciliation_complete: false, automatic_adoption_delivery_bridge: false, failure: report.failure ?? null }));
  process.exitCode = report.status === 'qualified_fixture_lane' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
