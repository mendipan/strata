import { z } from 'zod';
import { fail } from './model.js';
import type { Engine } from './core.js';
import type { AuthorityIssuer, SecurityContext } from './security.js';
import type { ProfileServiceScope } from './profile-service.js';
import { PROFILE_OPERATIONS, buildRecordType, buildRecordReferences } from './build-records.js';
import { BUILD_OPERATIONS, BUILD_RECOVERY_OPERATION } from './build-operations.js';
import { attemptRecordType, attemptReferences } from './build-attempt-records.js';

// Host-owned request metadata; never semantic records or operation-envelope fields.
// Callback data and any custom public/original result retain separate meanings.
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/);
export const repositoryStepSchema = z.object({
  format: z.literal('strata-repository-step/1'), kind: z.enum(['private', 'original']),
  project_id: id, repository_id: id, principal_id: id,
  command: z.string().min(1).max(128), input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  callback_result: z.unknown(), created_refs: z.array(z.string().max(256)).max(10000),
}).strict();
export type RepositoryStep = z.infer<typeof repositoryStepSchema>;

function repositoryVisibility(context:SecurityContext,engine:Engine,scope:ProfileServiceScope){
  const visited=new Set<string>();
  const visible=(ref:string)=>{
    if(visited.has(ref))return;visited.add(ref);
    const record=engine.records[ref];
    if(!record||!engine.canInspect(ref,context.principal_id)||scope.visible&&!scope.visible(ref))fail('BUILD_SOURCE_UNAVAILABLE',3,'Private receipt lost its visible immutable record.');
    if(record.data.repository_id&&record.data.repository_id!==scope.repository_id)fail('REPOSITORY_FORBIDDEN',4,'Private receipt references another repository.');
    const references=buildRecordType(record.type)?buildRecordReferences(record.type,record.data):attemptRecordType(record.type)?attemptReferences(record.type,record.data):[];
    for(const pin of references)visible(pin.ref);
  };
  return visible;
}

export function assertRepositoryStep(value:unknown,context:SecurityContext,engine:Engine,issuer:AuthorityIssuer,scope?:ProfileServiceScope,replayCommand?:string){
  const parsed=repositoryStepSchema.safeParse(value);
  if(!parsed.success)fail('STORE_UNAVAILABLE',9,'Retained private repository receipt is invalid.');
  const step=parsed.data;
  if(!scope)fail('UNSUPPORTED_CAPABILITY',8,'Original private outcome requires its mounted repository backend.');
  if(step.project_id!==context.project_id||step.project_id!==scope.project_id||step.repository_id!==scope.repository_id||step.principal_id!==context.principal_id)
    fail('REPOSITORY_FORBIDDEN',4,'Original private outcome belongs to another repository or actor.');
  const profile=PROFILE_OPERATIONS.includes(step.command as any);
  const action=replayCommand??(profile?(step.command.startsWith('profile.')?'profile.inspect':'repository.compatibility'):'build.inspect');
  issuer.authorize(context,action,{},engine);
  const scoped=PROFILE_OPERATIONS.includes(action as any)||BUILD_OPERATIONS.includes(action as any)||action===BUILD_RECOVERY_OPERATION?action:replayCommand?'build.start':'build.inspect';
  if(scoped!==action)issuer.authorize(context,scoped,{},engine);
  issuer.assertRepository(context,scoped,step.repository_id,[]);
  const visible=repositoryVisibility(context,engine,scope);
  for(const ref of step.created_refs){
    visible(ref);const record=engine.records[ref];
    if(replayCommand&&record.type==='build-contract-review'&&!issuer.permitsApproval(context,'release'))
      fail('AUTHORITY_FORBIDDEN',4,'Review replay requires current Release-review authority.');
  }
}

/** Used by broker and direct adapter original-outcome projections alike. */
export function assertRepositoryReceipt(receipt:{result:any;repository_step?:RepositoryStep},context:SecurityContext,engine:Engine,issuer:AuthorityIssuer,scope?:ProfileServiceScope){
  if(receipt.repository_step){assertRepositoryStep(receipt.repository_step,context,engine,issuer,scope);return;}
  const visible=scope?repositoryVisibility(context,engine,scope):undefined;
  // Legacy envelopes retain broker-authored created refs independent of payload.
  for(const ref of receipt.result.created??[]){
    const record=engine.records[ref];
    if(!record||!buildRecordType(record.type)&&!attemptRecordType(record.type))continue;
    if(!scope)fail('UNSUPPORTED_CAPABILITY',8,'Original supporting outcome requires the configured repository backend.');
    const action=attemptRecordType(record.type)?'build.inspect':record.type==='build-profile'?'profile.inspect':'repository.compatibility';
    issuer.authorize(context,action,{},engine);issuer.assertRepository(context,action,scope.repository_id,[]);
    if(record.data.repository_id!==scope.repository_id||record.data.project_id!==scope.project_id)
      fail('REPOSITORY_FORBIDDEN',4,'Original supporting outcome belongs to another repository or actor.');
    visible!(ref);
  }
}
