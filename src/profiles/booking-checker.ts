import { canonical, digest, bytesDigest, fail, type Snapshot } from '../model.js';

export const FIXTURE_DEFINITION = {format:'booking-fixtures/2',resource:'room',first:'a',second:'b',boundaries:['expiry-minus-one','expiry','reminder-minus-one','reminder','repeat-tick','next-hold'],checks:['booking.exclusive','booking.expiry','booking.reminder','booking.once','booking.lifecycle','intent.review']} as const;
export type BookingOracle = {format:'booking-oracle/1'; snapshot_sha256:string; expected:{seconds:number;enabled:boolean;lead_seconds:number}; criteria:{check:string;version:string;fixture:string;method:'mechanical'|'review'}[]};
export function fixtureOracle(snapshot:Snapshot): BookingOracle {
  const hold=snapshot.blocks['booking.hold']?.requirements.expiry,reminder=snapshot.blocks['booking.reminder']?.requirements.timing;
  const seconds=hold?.parameters.seconds,enabled=reminder?.parameters.enabled,lead_seconds=reminder?.parameters.lead_seconds;
  if(!Number.isInteger(seconds) || (seconds as number)<1 || typeof enabled!=='boolean' || !Number.isInteger(lead_seconds) || (lead_seconds as number)<0 || (enabled && (lead_seconds as number)>=(seconds as number))) fail('INVALID_ORACLE',6,'Host oracle requires recognized booking intent with valid timing.');
  const criteria=[...new Map(Object.values(snapshot.blocks).flatMap(b=>Object.values(b.acceptance)).map(c=>{const row={check:c.check,version:c.version,fixture:c.fixture,method:c.method};return [canonical(row),row] as const;})).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  return {format:'booking-oracle/1',snapshot_sha256:digest(snapshot),expected:{seconds:seconds as number,enabled,lead_seconds:lead_seconds as number},criteria};
}
// This complete function is the checker artifact. Profiles pin its actual JS source;
// all assertion helpers are inside the function and input constants are pinned separately.
export function bookingCheckSuite(createBooking:any,config:any,expected:BookingOracle['expected'],fixture:typeof FIXTURE_DEFINITION) {
  const results:Record<string,{passed:boolean;failure:string|null;observations:Record<string,unknown>}>={};
  const equal=(actual:unknown,value:unknown,code:string)=>{if(JSON.stringify(actual)!==JSON.stringify(value)) throw new Error(code);};
  for(const name of fixture.checks) { const seen:Record<string,unknown>={};try {
    if(name==='intent.review') {results[name]={passed:true,failure:null,observations:{attestation:'local fixture review only'}};continue;}
    equal({seconds:config?.seconds,enabled:config?.enabled,lead_seconds:config?.lead_seconds},expected,'ORACLE_CONFIGURATION');const app=createBooking();const first=app.hold(fixture.resource,fixture.first);seen.first_hold=first;equal(first.accepted,true,'FIRST_HOLD');equal(first.expires,expected.seconds,'EXPECTED_EXPIRY');
    if(name==='booking.exclusive') {const second=app.hold(fixture.resource,fixture.second);seen.competing_hold=second;equal(second.accepted,false,'EXCLUSIVE_REJECTION');equal(Object.keys(app.state().holds).length,1,'EXCLUSIVE_COUNT');}
    if(name==='booking.expiry') {app.advance(expected.seconds-1);seen.before_expiry=app.state();equal(Object.keys(app.state().holds).length,1,'HOLDS_BEFORE_EXPIRY');app.advance(1);seen.at_expiry=app.state();equal(Object.keys(app.state().holds).length,0,'HOLDS_AT_EXPIRY');}
    if(name==='booking.reminder') {if(expected.enabled) {const at=expected.seconds-expected.lead_seconds;app.advance(at-1);equal(app.state().reminders.length,0,'REMINDER_BEFORE');app.advance(1);seen.reminder=app.state();equal(app.state().reminders.length,1,'REMINDER_COUNT');equal(app.state().reminders[0].at,at,'REMINDER_AT');}else {app.advance(expected.seconds-1);equal(app.state().reminders.length,0,'REMINDERS_DISABLED');}}
    if(name==='booking.once') {if(expected.enabled) {app.advance(expected.seconds-expected.lead_seconds);app.advance(0);app.advance(1);seen.reminders=app.state().reminders;equal(app.state().reminders.length,1,'REMINDER_ONCE');}else {app.advance(expected.seconds);equal(app.state().reminders.length,0,'REMINDERS_DISABLED');}}
    if(name==='booking.lifecycle') {app.advance(expected.seconds);seen.next_hold=app.hold(fixture.resource,fixture.second);equal((seen.next_hold as any).accepted,true,'NEXT_HOLD');}
    results[name]={passed:true,failure:null,observations:seen};
  }catch(error:any) {results[name]={passed:false,failure:error.message,observations:seen};}}
  return results;
}
export const checkerArchive=()=>({format:'booking-checker/2',source:bookingCheckSuite.toString(),fixture:FIXTURE_DEFINITION});
export const checkerDigest=()=>bytesDigest(bookingCheckSuite.toString());
export const fixtureDigest=(oracle:BookingOracle)=>digest({fixture:FIXTURE_DEFINITION,criteria:oracle.criteria});
