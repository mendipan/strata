import { profileFor } from '../profile.js';
import { canonical,bytesDigest,digest } from '../model.js';
/** Fixed implementation archived as data; invoked only in the new bounded worker. */
export async function executeRecognizedCounter(packet:any) {
  const {module_bytes,expected_module,checker_pins,oracle,criteria}=packet;
  const checker=profileFor('counter-fixture/1').checker;
  if(module_bytes!==expected_module||bytesDigest(module_bytes)!==packet.module_sha256||checker.digest()!==checker_pins.sha256||
    checker.fixtureDigest(oracle)!==checker_pins.fixture_sha256||digest(oracle)!==checker_pins.oracle_sha256)throw new Error('input mismatch');
  const module=await import('data:text/javascript;base64,'+Buffer.from(module_bytes).toString('base64'));
  const measured=checker.run(module,oracle);
  const selected=new Set(criteria.filter((c:any)=>c.method==='mechanical').map((c:any)=>c.check));
  const checks=Object.fromEntries(Object.entries(measured.checks).filter(([id])=>selected.has(id)&&id!=='intent.review'));
  const results=criteria.filter((c:any)=>c.method==='mechanical').map((c:any)=>({...c,passed:checks[c.check]?.passed===true,reviewer:null}));
  const output={ok:true,results,observations:{checks,oracle_sha256:digest(oracle)}};
  if(Buffer.byteLength(canonical(output))>262144)throw new Error('IPC bound');
  return output;
}
