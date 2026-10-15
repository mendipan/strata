import { directSmokePlan } from '../src/artifacts-rest-smoke.js';
if (process.argv.slice(2).length === 1 && process.argv[2] === '--plan') process.stdout.write(JSON.stringify(directSmokePlan, null, 2) + '\n');
else { process.stdout.write(JSON.stringify({ ok: false, exit_code: 7, code: 'REMOTE_TRANSPORT_UNAVAILABLE', message: 'Preparation only. Use --plan; live execution/authentication is disabled.' }) + '\n'); process.exitCode = 7; }
