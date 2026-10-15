import { BLOCK_MODEL, digest, fail } from '../model.js';
import { counterProfile } from './counter-fixture.js';
import type { ProfileAdapter } from '../profile-types.js';
export const HOST_COUNTER_PROFILE='counter-host/1';
const archive=()=>({format:'strata-host-profile/1',id:HOST_COUNTER_PROFILE,model_version:BLOCK_MODEL,base:counterProfile.archive(),review:'authenticated-criterion-attestation/1'});
// An explicit finite profile, never support for arbitrary newly-created Blocks.
// Mechanical checker/template semantics reuse the bounded counter implementation.
export const hostCounterProfile:ProfileAdapter={...counterProfile,id:HOST_COUNTER_PROFILE,models:[BLOCK_MODEL],scenario:{...counterProfile.scenario,models:[BLOCK_MODEL]},archive,
  materialize(target,evaluation){if(Object.values(evaluation.snapshot.blocks).some(b=>Object.keys(b.asset_refs??{}).length))fail('UNSUPPORTED_OBLIGATION',8,'Hosted counter profile does not consume background assets.');const realized=counterProfile.materialize(target,evaluation);return {...realized,profile_id:HOST_COUNTER_PROFILE,profile:digest(archive()),coverage:realized.coverage.map(c=>({...c,rationale:'Recognized finite counter intent. Mechanical results require a measured host run; review requires a separate authenticated attestation.'}))};}
};
