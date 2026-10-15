import { parentPort, workerData } from 'node:worker_threads';
import { profileFor, verifyRealization } from '../profile.js';
// Only hostRunner starts this worker after exact compiled-file verification.
try{
  const record=verifyRealization(workerData.record),checker=profileFor(record.profile_id).checker;
  // Execute the verified immutable template bytes in memory. A slot file changed
  // after the host read cannot change the module that runs in this worker.
  const module=await import('data:text/javascript;base64,'+Buffer.from(record.files[checker.entrypoint]).toString('base64'));
  const measured=checker.run(module,record.oracle!);
  const criteria=[...new Map(record.coverage.flatMap(c=>c.checks.filter(k=>k.method==='mechanical').map(k=>[JSON.stringify(k),k] as const))).values()];
  const results=criteria.map(c=>({...c,passed:measured.checks[c.check]?.passed===true}));
  parentPort!.postMessage({ok:true,evidence:{results},observations:measured.observations});
}catch{parentPort!.postMessage({ok:false});}
