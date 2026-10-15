import { el, pill, fields } from './dom.js';

const prefix='strata-studio-pending-agent/2:',uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),generation=v=>Number.isSafeInteger(v)&&v>=1;
function safeAction(v){return v&&['configure','test','connect','retry','disconnect','revoke','remove'].includes(v.action)&&Number.isSafeInteger(v.revision)&&v.revision>=0&&uuid(v.request_id)&&Object.keys(v).sort().join(',')===(v.action==='configure'?'action,request_id,revision,target_profile_id':'action,request_id,revision')&&(v.action!=='configure'||/^[A-Za-z0-9_.:/-]{1,256}$/.test(v.target_profile_id));}
const reasons={
  AGENT_SOURCE_UNCONFIGURED:'Select the exact approved source before configuring discovery.',
  AGENT_TARGET_UNCONFIGURED:'The host operator must approve a real discovery service and its fixed profile.',
  AGENT_AUTH_UNCONFIGURED:'The approved service authentication adapter is not configured.',
  AGENT_APPROVAL_REQUIRED:'The exact target approval is missing or changed. Ask the host operator to check it.',
  AGENT_STATE_UNAVAILABLE:'Protected agent state needs operator reconciliation. No history was reset.',
  AGENT_RECOVERY_REQUIRED:'Inspect the interrupted action. The host operator must reconcile protected state.',
  AGENT_CHANGED:'The source, owner or service authority changed. Refresh status and inspect the original action.',
  AGENT_EXPIRED:'Current discovery or a finite host policy expired. Saved integration consent remains; check the host policy and retry when available.',
  AGENT_SESSION_EXPIRED:'The service credential session expired. Your integration consent remains saved. A supported authentication adapter must renew the session before retrying.',
  AGENT_REVOKED:'Integration consent was revoked. Configure the approved service again to authorize a new connection.',
  OWNER_REAUTH_REQUIRED:'Confirm your password, then explicitly retry the original action.',
};
export async function agentSettings(ctx){
  const root=el('section',{class:'section','aria-labelledby':'agent-settings'}),pane=el('div'),feedback=el('p',{class:'notice',role:'status','aria-live':'polite'});
  let status=null,error=null,unconfirmed=false,busy=false,abort=null,pending=null,pendingGeneration=null,key=null,canRetry=false,absent=false,profile='';
  const valid=()=>{ctx.check();if(!root.isConnected)throw new DOMException('Interrupted','AbortError');};
  function namespace(next){
    const scope=next.reconciliation_scope;
    const nextKey=hash(scope?.owner)&&hash(scope?.state)?prefix+scope.owner+':'+scope.state:null;
    if(nextKey===key){if(scope?.authentication_generation!==status?.reconciliation_scope?.authentication_generation){canRetry=false;absent=false;}return;}
    key=nextKey;pending=null;pendingGeneration=null;canRetry=false;absent=false;
    try{const text=key&&sessionStorage.getItem(key);if(text&&text.length<=2048){const saved=JSON.parse(text);if(saved.format==='strata-studio-pending-agent/2'&&Object.keys(saved).sort().join(',')==='authentication_generation,body,format'&&generation(saved.authentication_generation)&&safeAction(saved.body)){pending=saved.body;pendingGeneration=saved.authentication_generation;}}}catch{}
  }
  function setStatus(next){namespace(next);status=next;error=null;unconfirmed=false;if(!status.profiles.some(p=>p.target_profile_id===profile))profile=status.profiles[0]?.target_profile_id??'';}
  function retain(body,originalGeneration=status?.reconciliation_scope?.authentication_generation){
    if(!key||!generation(originalGeneration)||originalGeneration!==status?.reconciliation_scope?.authentication_generation||!safeAction(body)||new TextEncoder().encode(JSON.stringify(body)).byteLength>1024)throw new Error('Current owner and original authentication generation are required before dispatch.');
    try{sessionStorage.setItem(key,JSON.stringify({format:'strata-studio-pending-agent/2',authentication_generation:originalGeneration,body}));}catch{throw new Error('This browser cannot retain the action identity. Enable session storage before dispatching.');}
    pending=body;pendingGeneration=originalGeneration;canRetry=false;absent=false;
  }
  function resolved(){if(key)try{sessionStorage.removeItem(key);}catch{}pending=null;pendingGeneration=null;canRetry=false;absent=false;}
  function unverified(e){error=e.message;unconfirmed=true;canRetry=false;absent=false;feedback.textContent='Agent status could not be verified. Refresh status after resolving the displayed error; retained tests are historical.';paint();}
  async function reload(){try{const next=await ctx.request('agents',{signal:ctx.signal});valid();setStatus(next);paint();}catch(e){valid();unverified(e);throw e;}}
  async function run(action,exact){
    if(busy||unconfirmed||pending&&!exact)return;
    const body=exact??{action,revision:status.revision,request_id:crypto.randomUUID(),...(action==='configure'?{target_profile_id:profile}:{})};
    try{retain(body,exact?pendingGeneration:status?.reconciliation_scope?.authentication_generation);}catch(e){feedback.textContent=e.message;return;}
    busy=true;unconfirmed=true;abort=new AbortController();paint();feedback.textContent=['test','connect','retry'].includes(action)?'Verifying one bounded service discovery exchange.':'Saving the local agent configuration action.';
    try{
      const next=await ctx.request('agents',{method:'POST',body,signal:AbortSignal.any([ctx.signal,abort.signal])});valid();setStatus(next);
      if(['completed','failed'].includes(next.outcome?.state))resolved();
      feedback.textContent=next.outcome?.code?next.outcome.code+': '+(reasons[next.outcome.code]??'Service discovery was not verified. Inspect the saved outcome.') :['connect','retry'].includes(action)?'Service discovery verified. Engine authority and chat remain unavailable.':action==='test'?'Discovery test passed. The agent remains disconnected.':action==='revoke'?'Agent integration revoked. Saved receipts remain; this service cannot be retried until you approve it again.':action==='configure'?'Agent consent saved until you revoke it. Connect to verify current service health.':'Agent action saved.';
      ctx.announce(feedback.textContent);
    }catch(e){
      try{valid();}catch{return;}
      feedback.textContent=e.name==='AbortError'?'Stopped waiting. Check the saved outcome; dispatched work may have continued.':(reasons[e.code]??e.message);
      if(e.code==='OWNER_REAUTH_REQUIRED'&&ctx.reauth){const confirmed=await ctx.reauth({signal:ctx.signal});valid();if(confirmed)await reload().catch(()=>{});}
      else if(e.code==='AGENT_CHANGED')await reload().catch(()=>{});
    }finally{busy=false;abort=null;try{valid();paint();}catch{}}
  }
  async function inspect(){
    if(!pending||busy)return;busy=true;canRetry=false;absent=false;paint();
    try{
      const result=await ctx.request('agent-outcome:'+pending.request_id,{signal:ctx.signal});valid();
      if(['completed','failed'].includes(result.state)){resolved();feedback.textContent=result.code?result.code+': '+(reasons[result.code]??'Discovery failed; no engine authority was granted.'):'Saved agent action confirmed. No probe was replayed.';await reload();}
      else feedback.textContent=result.state==='interrupted'?'The interrupted action needs operator reconciliation. Its original receipt remains.':'The bounded action is still pending. Check again explicitly.';
    }catch(e){
      try{valid();}catch{return;}
      if(e.code==='NOT_FOUND'){
        const id=pending?.request_id;await reload().catch(()=>{});
        absent=!!pending&&pending.request_id===id;canRetry=absent&&!unconfirmed&&pendingGeneration===status?.reconciliation_scope?.authentication_generation;
        feedback.textContent=canRetry?'No saved receipt exists. Retry this exact action explicitly or dismiss the unsaved action.':absent?(unconfirmed?'No saved receipt exists. Refresh status before retrying; the action can be dismissed.':'No saved receipt exists. Retry is unavailable for this original authentication generation; dismiss the unsaved action.'):'The owner or protected state changed. This action belongs to its original recovery scope.';
      }else feedback.textContent=e.message;
    }
    finally{busy=false;try{valid();paint();}catch{}}
  }
  function cancel(){abort?.abort();feedback.textContent='Stopped waiting. This does not roll back a dispatched exchange. Check its saved outcome.';}
  async function confirmRemove(action='remove'){
    const prior=document.activeElement,dialog=el('dialog',{class:'owner-dialog','aria-labelledby':'agent-remove-title'});
    let closed=false;const close=()=>{if(closed)return;closed=true;ctx.signal.removeEventListener('abort',close);dialog.close();dialog.remove();if(prior?.isConnected)prior.focus();};
    const revoke=action==='revoke',title=revoke?'Revoke agent connection':'Remove agent connection';
    dialog.append(el('h2',{id:'agent-remove-title'},title),el('p',{},revoke?'Revoke persistent consent for this service and stop current local waiting. A dispatched request may already have reached the service. You must approve a new connection before using it again.':'Remove the visible configuration and its consent. Retained action history and rate reservations remain on the server.'),el('div',{class:'toolbar'},el('button',{onclick:()=>{close();void run(action);}},title),el('button',{onclick:close},'Cancel')));
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});ctx.signal.addEventListener('abort',close,{once:true});document.body.append(dialog);dialog.showModal();dialog.querySelector('button:last-child').focus();
  }
  function paint(){
    const c=status?.connection,disabled=busy||!!pending||unconfirmed,code=c?.error?.code??status?.management?.code,discovery=!unconfirmed&&c?.runtime_ready?c.current_discovery:null;
    root.dataset.agentRevision=String(status?.revision??'unconfigured');
    pane.replaceChildren(el('article',{class:'card'},el('div',{class:'card-head'},el('h3',{},'Cloudflare service discovery'),pill(unconfirmed?'Status unverified':c?.state??'Service not configured')),
      !ctx.owner?el('div',{},pill('Chat unavailable'),el('p',{},'No agent protocol or chat service is configured. Sign in as the installation owner to inspect approved discovery settings.')):null,
      fields([['Project',c?.binding.project_id??'No bound project'],['Model',c?.binding.model_version??'Unavailable'],['Repository',c?.binding.repository_id??'Unavailable'],['Approved profile',c?.target_profile_id??'None configured'],['Integration consent',unconfirmed?'Unverified':status?.integration?.state==='approved'?'Saved until you revoke it':status?.integration?.state==='revoked'?'Revoked':status?.integration?.state==='legacy'?'Legacy configuration; confirm durable consent':'No consent saved'],['Connection intent',status?.integration?.enabled?'Enabled; retained across restarts':'Paused'],['Service health',unconfirmed?'Unverified':status?.health?.state??'unavailable'],['Session renewal','No provider renewal adapter configured'],['Current discovery',discovery?`Verified until ${discovery.valid_until}`:'Not verified for current use'],['Last discovery test',c?.last_test?`${c.last_test.outcome} - ${c.last_test.at} (historical)`:'Not tested'],['Engine authority','Not configured'],['Tasks, tools and chat','Unavailable']]),
      code?el('p',{class:'notice'},code+': '+(reasons[code]??c?.error?.message??'The approved discovery contract is unavailable.')):null,
      error?el('p',{class:'notice',role:'alert'},error):null,
      discovery?el('p',{},'Advertised service features: '+(discovery.advertised_features.join(', ')||'None')+'. These are service metadata and grant no Strata operation.'):null,
      !c||status?.integration?.state==='revoked'||status?.integration?.state==='legacy'?el('form',{onsubmit:event=>{event.preventDefault();void run('configure');}},el('label',{for:'agent-profile'},'Approved agent service'),el('select',{id:'agent-profile',disabled:disabled||!status?.capabilities.configure,onchange:event=>profile=event.target.value},...(status?.profiles??[]).map(p=>el('option',{value:p.target_profile_id,selected:p.target_profile_id===profile},p.target_profile_id))),el('p',{class:'muted'},'Configure authorizes this exact approved service for this repository until you revoke or remove it. Service sessions and health still expire.'),el('button',{type:'submit',disabled:disabled||!profile||!status?.capabilities.configure},'Configure agent')):null,
      el('div',{class:'toolbar'},...(['test','connect','disconnect'].map(action=>el('button',{disabled:disabled||!status?.capabilities[action],onclick:()=>run(action)},{test:'Test agent discovery',connect:'Connect agent discovery',disconnect:'Disconnect agent'}[action]))),
        el('button',{disabled:disabled||!status?.capabilities.retry,onclick:()=>run('retry')},'Retry agent connection'),
        el('button',{disabled:disabled||!status?.capabilities.revoke,onclick:()=>confirmRemove('revoke')},'Revoke agent connection'),
        el('button',{disabled:disabled||!status?.capabilities.remove,onclick:()=>confirmRemove()},'Remove agent'),
        status?.owner_confirmation_required&&ctx.reauth?el('button',{disabled:busy,onclick:async()=>{if(await ctx.reauth({signal:ctx.signal}))await reload().catch(()=>{});}},'Confirm agent changes'):null,
        ctx.owner?el('button',{disabled:busy,onclick:()=>reload().catch(()=>{})},'Refresh agent status'):null,
        busy?el('button',{onclick:cancel},'Cancel agent waiting'):null),
      status&&c&&!status.capabilities.remove?el('p',{class:'muted'},'Configuration changes require a fresh owner confirmation and the current approved source.'):null,
      el('p',{class:'muted'},'Consent and enabled connection intent persist across browser and server restarts until you revoke them. Disconnect pauses connection intent and retains consent. Opening Settings never probes. Retry verifies short-lived discovery without repeating setup; automatic service session renewal is unavailable. Agent tasks, tools, inference and chat are not available.')),
      ...(pending?[el('p',{class:'notice'},'Unresolved agent action: '+pending.action+'. Original request ',el('code',{},pending.request_id),pendingGeneration!==status?.reconciliation_scope?.authentication_generation?' — Earlier sign-in generation: inspect its outcome; replay is unavailable.':'')]:[]),
      el('div',{class:'toolbar'},pending&&!busy?el('button',{onclick:inspect},'Check saved agent outcome'):null,canRetry&&pending&&!busy?el('button',{onclick:()=>run(pending.action,pending)},'Retry exact agent action'):null,absent&&pending&&!busy?el('button',{onclick:()=>{resolved();feedback.textContent='Dismissed the unsaved action after an explicit outcome check.';paint();}},'Dismiss unsaved agent action'):null));
  }
  root.append(el('h2',{id:'agent-settings'},'Agent connection'),feedback,pane);
  if(ctx.owner){try{const next=await ctx.request('agents',{signal:ctx.signal});ctx.check();setStatus(next);}catch(e){ctx.check();unverified(e);}}
  paint();return root;
}
