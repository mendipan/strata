import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readConformanceApproval} from '../scripts/studio-namespace-conformance.js';

// This probe runs only in the isolated POSIX fixture, as an unprivileged UID
// with empty capabilities. It invokes the exact child-side approval reader.
const [filename,bindingText,nowText]=process.argv.slice(2);
assert.notEqual(process.getuid?.(),0);
const status=await readFile('/proc/self/status','utf8');
for(const name of ['CapEff','CapPrm','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+name+':\\s+0+$','m'));
assert.match(status,/^NoNewPrivs:\s+1$/m);
try{
  const approval=await readConformanceApproval(filename,JSON.parse(bindingText),Number(nowText));
  process.stdout.write(JSON.stringify({status:'approval-admitted',uid:process.getuid?.(),run_id:approval.run_id,capabilities_empty:true,provider_calls:0,credential_calls:0})+'\n');
}catch{
  process.stdout.write(JSON.stringify({status:'approval-refused',uid:process.getuid?.(),capabilities_empty:true,provider_calls:0,credential_calls:0})+'\n');
  process.exitCode=4;
}
