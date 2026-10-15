import {el,fields,pill} from './dom.js';
import {namespaceFailure} from './connection-feedback.js';

export function namespaceSettingsView(ctx,initial){
  let status=initial,busy=false,pending=null,consented=false,discovery=null,verifiedRevision=null;
  const root=el('section',{class:'section'}),pane=el('div'),feedback=el('p',{role:'status','aria-live':'polite'});
  const storageKey=`strata-namespace-settings-outcome/1:${status.scope_sha256}`;
  const valid=()=>{ctx.check();if(!root.isConnected)throw new DOMException('Interrupted','AbortError');};
  try{const saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');
    if(saved&&/^[a-f0-9-]{36}$/i.test(saved.request_id)&&['approve','pause','resume','revoke','discover'].includes(saved.action))pending=saved;
  }catch{}
  function forget(){sessionStorage.removeItem(storageKey);pending=null;}
  async function refresh(){status=await ctx.request('settings',{signal:ctx.signal});valid();}
  // Inspect the original request locally after a lost response; never replay it.
  async function recover(){
    if(!pending)return true;
    const result=await ctx.request('connection-outcome:'+pending.request_id,{signal:ctx.signal});valid();
    if(!result.operation||['completed','failed'].includes(result.operation.phase)){forget();await refresh();return true;}
    return false;
  }
  async function send(action){
    const body={action,revision:status.revision,request_id:crypto.randomUUID(),
      ...(action==='approve'?{scope_sha256:status.scope_sha256,acknowledgment:'until-revoked-development-namespace',...(status.scope.first_project?{project_authority_sha256:status.scope.first_project.authority_sha256}:{})}:{}),
      ...(action==='discover'?{search:'',cursor:null}:{})};
    sessionStorage.setItem(storageKey,JSON.stringify({request_id:body.request_id,action}));pending={request_id:body.request_id,action};
    try{status=await ctx.request('settings',{method:'POST',body,signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(70000)])});}
    catch(e){if(e.code!=='OWNER_REAUTH_REQUIRED')throw e;
      if(!await ctx.reauth?.({signal:ctx.signal})){forget();throw Error('Password confirmation cancelled. Your connection was not changed.');}
      status=await ctx.request('settings',{method:'POST',body,signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(70000)])});
    }
    valid();if(status.outcome?.phase!=='completed')throw Error('This action is still being resolved. Check connection status before continuing.');
    forget();return status;
  }
  async function run(action){
    if(busy||pending)return;busy=true;paint();
    feedback.textContent=action==='connect'?'Connecting to Cloudflare and loading repositories…':'Saving your connection choice…';
    try{
      if(action==='connect'){
        if(!status.approved)await send('approve');else if(!status.connected)await send('resume');
        await send('discover');discovery=status.discovery;verifiedRevision=ctx.getToken?.()?.revision;
        feedback.textContent=`Connected to ${status.scope.namespace}. ${discovery.repositories.length} ${discovery.repositories.length===1?'repository':'repositories'} available. Choose a repository to continue.`;
      }else{
        await send(action);discovery=null;ctx.onConnectionUnavailable?.();
        feedback.textContent=action==='pause'?'Disconnected. Your saved token, projects and authorization are retained.':'Repository authorization revoked. Your projects and saved token are retained.';
      }
      ctx.announce?.(feedback.textContent);
    }catch(e){if(!ctx.signal.aborted){discovery=null;feedback.textContent=namespaceFailure(e,action);try{await recover();}catch{} }}
    finally{busy=false;try{valid();paint();}catch{}}
  }
  function paint(){
    const token=ctx.getToken?.(),saved=token?.configured===true;
    if(verifiedRevision!==token?.revision)discovery=null;
    const enabled=status.approved&&!status.revoked&&status.connected,disabled=busy||!!pending;
    pane.replaceChildren(el('article',{class:'card'},el('div',{class:'toolbar'},pill(status.revoked?'Access revoked':discovery?'Connected':enabled?'Access saved':status.approved?'Disconnected':'Not connected'),pill('Until you revoke access')),
      fields([['Account',status.scope.account],['Namespace',status.scope.namespace]]),
      el('p',{},saved?'Use your securely saved Artifacts API token.':token?.configured===false?'Save your Artifacts API token below to connect.':'Checking your saved token…'),
      !status.approved&&!status.revoked?el('div',{},
        el('p',{},'Allow Studio to list repositories, create projects, read records and save drafts in this namespace. Access stays enabled until you revoke it; your sign-in still expires normally.'),
        el('details',{},el('summary',{},'Access details'),
          el('p',{},status.scope.first_project?`New ${status.scope.first_project.template} projects assign ${status.scope.first_project.principal_id} (${status.scope.first_project.account_id}) as author, reviewer, validator, scope selector, guardian and Release approver until ${status.scope.first_project.lifetime.expires_at}. The initial collection holds at most ${status.scope.first_project.max_items} items with titles up to ${status.scope.first_project.max_title_length} characters. One person holds all these roles. Every review and approval requires your action; checks measure the exact output. Agent execution requires separate consent.`:'This connection does not grant independent review, Release approval or agent execution.'),
          el('p',{},'Keep repository names unchanged while Studio writes or resolves an interrupted write. Cloudflare addresses repositories by name.'),
          el('p',{},`New repositories include an automatic Git token. Studio discards it; Cloudflare expires it within the approved ${Math.ceil(status.automatic_token_max_lifetime_seconds/3600)} hours.`)),
        el('label',{},el('input',{type:'checkbox',checked:consented,disabled,onchange:e=>{consented=e.target.checked;paint();}}),status.scope.first_project?' Allow namespace access until revoked and the displayed finite project roles until their expiry.':' Allow access to this namespace until I revoke it.')):null,
      status.revoked?el('p',{class:'notice'},'This authorization has been revoked. It cannot reconnect.'):el('div',{class:'toolbar'},
        saved?el('button',{disabled:disabled||!status.approved&&!consented,onclick:()=>run('connect')},busy?'Connecting…':discovery?'Refresh repositories':enabled?'Connect with saved token':'Connect'):null,
        enabled&&saved?el('button',{disabled:disabled||!ctx.openRepositories,onclick:()=>ctx.openRepositories(discovery)},'Choose repository'):null,
        enabled?el('button',{disabled,onclick:()=>run('pause')},'Disconnect'):null),
      status.approved&&!status.revoked?el('details',{},el('summary',{},'Manage access'),el('button',{disabled,onclick:()=>{const d=el('dialog',{},el('h2',{},'Revoke repository access?'),el('p',{},'This permanently revokes this authorization. Your projects, saved token and usage history remain on the server.'),el('button',{onclick:()=>{d.close();d.remove();void run('revoke');}},'Revoke access'),el('button',{onclick:()=>{d.close();d.remove();}},'Cancel'));document.body.append(d);d.showModal();}},'Revoke access')):null,
      pending?el('div',{class:'notice'},el('p',{},'The previous connection request has not finished. Check its status before retrying.'),el('button',{disabled:busy,onclick:async()=>{busy=true;paint();try{feedback.textContent=await recover()?'Status checked. You can connect again.':'The request is still in progress. Try checking again shortly.';}catch(e){feedback.textContent=e.message;}finally{busy=false;paint();}}},'Check connection status')):null,
      el('details',{},el('summary',{},'Usage'),fields([['Requests reserved',`${status.usage.reserved.requests} / ${status.usage.limits.requests}`],['Transfer reserved',`${status.usage.reserved.bytes.toLocaleString()} / ${status.usage.limits.bytes.toLocaleString()} bytes`]]),el('p',{},'Usage is retained across disconnects, sign-ins and restarts.'))));
  }
  root.append(el('h2',{},'Artifacts namespace'),pane,feedback);
  root.refreshToken=paint;root.credentialChanged=()=>{discovery=null;ctx.onConnectionUnavailable?.();feedback.textContent='Token saved. Connect to load your repositories.';paint();};
  root.start=async()=>{if(pending){try{await recover();}catch{}paint();}};
  paint();return root;
}
