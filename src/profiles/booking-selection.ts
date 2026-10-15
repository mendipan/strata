import { CONTENT_MODEL, canonical, set } from '../model.js';
import type { SelectionEvaluator } from '../profile-types.js';
import { EXCLUSIVE, expiryRequirement, timingRequirement } from './booking.js';

// The existing exact S2 policy is a booking example adapter. It grants no authority.
export const bookingSelection: SelectionEvaluator = {
  id: 'booking-reminder-selection/1',
  supports: (model, scope) => model === CONTENT_MODEL && scope === 'booking',
  reason: 'One reviewed booking rule uniquely selects the exact 900-second dependency and reminder.',
  match(baseline, layers) {
    if (layers.length !== 3) return null;
    const hold=baseline.blocks['booking.hold'],reminder=baseline.blocks['booking.reminder'];
    if(!hold || !reminder || canonical(hold.requirements.exclusive)!==canonical(EXCLUSIVE) || canonical(hold.requirements.expiry)!==canonical(expiryRequirement(600)) || canonical(reminder.requirements.timing)!==canonical({...timingRequirement(false),acceptance:['once','timing']})) return null;
    const duration=(seconds:number)=>layers.filter(l=>canonical(l.data.changes)===canonical([{op:'set_item',block:'booking.hold',path:'requirements.expiry',expected:{kind:'value',value:hold.requirements.expiry},value:expiryRequirement(seconds)}]) && !l.data.acceptance.length && !l.data.requires_layers.length && !l.data.read_set.length && !l.data.assumptions.length && !l.data.resolution_proposals.length && l.data.derived_from===null);
    const a=duration(900),c=duration(1200);
    if(a.length!==1 || c.length!==1)return null;
    const b=layers.filter(l=>l.ref!==a[0].ref && l.ref!==c[0].ref && canonical(l.data.changes)===canonical([{op:'set_item',block:'booking.reminder',path:'requirements.timing',expected:{kind:'value',value:reminder.requirements.timing},value:{...timingRequirement(true),acceptance:['once','timing']}}]) && canonical(l.data.requires_layers)===canonical([a[0].ref]) && canonical(l.data.read_set)===canonical([{layer:a[0].ref,mode:'required'}]) && canonical(l.data.assumptions)===canonical([{block:'booking.hold',path:'requirements.expiry',expected:{kind:'value',value:expiryRequirement(900)}}]) && l.data.acceptance.length===1 && l.data.acceptance[0].block==='booking.reminder' && l.data.acceptance[0].id==='layer-reminder' && canonical(l.data.acceptance[0].criterion)===canonical({statement:'Verify booking.reminder for layer-reminder.',method:'mechanical',check:'booking.reminder',version:'1',fixture:'layer-reminder',subjects:['booking.reminder/requirements.timing']}) && !l.data.resolution_proposals.length && l.data.derived_from===null);
    if(b.length!==1)return null;
    return { id:'policy-selection', selected:set([a[0].ref,b[0].ref]), rejected:[c[0].ref] };
  }
};
