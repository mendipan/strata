// Only request identity is retained. Draft content and credentials stay out of storage.
const storageKey='strata-studio-pending';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function failure(message,code,status){const error=new Error(message);error.code=code;if(status!==undefined)error.status=status;return error;}
export function pendingOperation(storage=sessionStorage){
  try{const p=JSON.parse(storage.getItem(storageKey)||'null');
    return p&&uuid.test(p.key)&&typeof p.connection_id==='string'&&p.connection_id.length<=128&&typeof p.command==='string'&&/^[a-z][a-z.]{0,63}$/.test(p.command)?{key:p.key,connection_id:p.connection_id,command:p.command}:null;
  }catch{return null;}
}
export function retainOperation(pending,storage=sessionStorage){
  const old=pendingOperation(storage);
  if(old)throw failure('Reconcile operation '+old.key+' in its original repository’s Review inbox before starting another operation.','OPERATION_PENDING');
  try{storage.setItem(storageKey,JSON.stringify({key:pending.key,connection_id:pending.connection_id,command:pending.command}));}
  catch{throw failure('Browser recovery storage is unavailable. No request was sent. Restore session storage before saving.','OPERATION_RECOVERY_UNAVAILABLE');}
}
export function clearOperation(key,storage=sessionStorage){
  if(pendingOperation(storage)?.key===key)storage.removeItem(storageKey);
}
export const unconfirmedOperation=error=>error.outcome_unknown===true||['OPERATION_UNKNOWN','OPERATION_PENDING'].includes(error.code);
export const sessionRequired=error=>['OWNER_SESSION_REQUIRED','SESSION_REQUIRED','ACTOR_SESSION_REQUIRED'].includes(error.code)||error.status===401&&!['SOURCE_AUTH','SOURCE_BINDING'].includes(error.code);
export async function operationResponse(response,key,command){
  const unknown=()=>failure((response.status===413?'The server rejected this request at its payload-size limit. ':'Studio did not return a confirmed operation result. ')+
    '(HTTP '+response.status+'). Inspect operation '+key+' in Review before another save.','OPERATION_UNKNOWN',response.status);
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unknown();
  let result;try{result=await response.json();}catch{throw unknown();}
  if(!response.ok){if(!result?.error||typeof result.error.message!=='string')throw unknown();
    throw failure(result.error.message,result.error.code,response.status);
  }
  if(!result?.data||typeof result.data!=='object'||Array.isArray(result.data)||!result.data.data||typeof result.data.data!=='object'||Array.isArray(result.data.data))throw unknown();
  if(['init','layer.create','layer.revise','layer.restore','layer.publish','content.review','compose','approve','release'].includes(command)&&
      (typeof result.data.data.ref!=='string'||!result.data.data.ref.length))throw unknown();
  return result.data;
}
