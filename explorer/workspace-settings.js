import {el,fields,pill} from './dom.js';
export function workspaceSettingsView(ctx,initial){
  const root=el('div'),pane=el('div'),feedback=el('p',{role:'status','aria-live':'polite',class:'notice'});
  let status=initial,busy=false,uncertain=null,failed=false;
  const valid=()=>{ctx.check();if(!root.isConnected)throw new DOMException('Interrupted','AbortError');};
  const units=bytes=>Number.isSafeInteger(bytes)?`${bytes.toLocaleString()} bytes`:'Unavailable';
  async function refresh(){status=await ctx.request('settings',{signal:ctx.signal});valid();failed=false;paint();}
  async function control(action,replay){
    if(busy)return;if(action==='revoke'&&!replay&&!window.confirm('Permanently revoke access to '+status.project+'? Reconnecting will not restore this grant.'))return;
    busy=true;paint();const body=replay??{action,revision:status.revision,request_id:crypto.randomUUID()};
    try{
      if((action==='revoke'||action.startsWith('test-'))&&ctx.reauth&&!await ctx.reauth({signal:ctx.signal})){feedback.textContent='Action cancelled.';return;}
      status=await ctx.request('settings',{method:'POST',body,signal:ctx.signal});valid();uncertain=null;failed=false;
      feedback.textContent=action==='connect'?'Repository connected. Authoring still uses its separate approved account.':action==='disconnect'?'Repository paused. Usage and grant history are retained.':action==='revoke'?'Repository access permanently revoked.':action==='test-write'?'Write-token issue and cleanup verified. No repository content was published.':'Exact repository metadata verified. Write permission remains a separate check.';
      ctx.onConnectionUnavailable?.();
    }catch(error){if(ctx.signal.aborted)return;valid();feedback.textContent=error.message;failed=true;
      if(!error.code||['SETTINGS_TIMEOUT','SETTINGS_TOKEN_CHANGED'].includes(error.code))uncertain=body;
    }finally{busy=false;try{valid();paint();}catch{}}
  }
  async function author(){
    if(busy)return;busy=true;paint();
    try{let result;try{result=await ctx.useAuthoring?.(ctx.signal);}catch(error){if(error.code!=='OWNER_REAUTH_REQUIRED'||!ctx.reauth)throw error;if(!await ctx.reauth({signal:ctx.signal})){feedback.textContent='Authoring sign-in cancelled.';return;}result=await ctx.useAuthoring(ctx.signal);}
      valid();if(!result?.authenticated)throw Error('The host has not approved this owner as a named author.');await refresh();feedback.textContent='Named authoring access is active for compatible draft operations.';
    }catch(error){if(ctx.signal.aborted)return;valid();failed=true;ctx.onConnectionUnavailable?.();feedback.textContent=error.message;}
    finally{busy=false;try{valid();paint();}catch{}}
  }
  function paint(){
    const token=ctx.getToken?.(),actor=!!status.actor_state?.authenticated,revoked=status.grant?.state==='revoked',limits=status.usage?.limits,reserved=status.usage?.reserved,remaining=status.usage?.remaining;
    const disabled=busy||ctx.signal.aborted;
    const providerAccepted=status.capabilities?.provider_write_contract_accepted===true||status.capabilities?.provider_identity_verified===true;
    pane.replaceChildren(el('section',{class:'section'},el('h2',{},'Repository workspace'),el('article',{class:'card'},
      el('div',{class:'toolbar'},pill(revoked?'Revoked':status.desired_connected?'Connected':'Paused'),pill(status.grant?.lifetime?.mode==='until-revoked'?'Until revoked':'Expires '+status.grant?.lifetime?.expires_at)),
      fields([['Project',status.project],['Repository ID',status.repository_id],['Model',status.model_version],['Named author',status.actor_state?.principal_id??'Separate authoring sign-in required'],
        ['Saved provider token',token?.configured===true?'Saved':token?.configured===false?'Not saved':'Status unavailable'],
        ['Write-token check',status.capabilities?.write_token_verified?'Issue and owned cleanup verified':'Not verified for the current token'],
        ['Last repository test',status.last_test?status.last_test.error??status.last_test.kind+' passed':'Not tested'],
        ['Reserved requests',reserved&&limits?`${reserved.requests.toLocaleString()} / ${limits.requests.toLocaleString()}`:'Unavailable'],
        ['Reserved transfer',reserved&&limits?`${units(reserved.bytes)} / ${units(limits.bytes)}`:'Unavailable'],['Remaining',remaining?`${remaining.requests.toLocaleString()} requests; ${units(remaining.bytes)}`:'Unavailable']]),
      el('p',{},'Existing v0.1 history is preserved. This workspace supports named draft authoring and composition. Authenticated Release and hosted application Git are unavailable.'),
      status.capabilities?.provider_write_contract==='development-name-addressed'?el('p',{class:'notice',role:'status'},'Development connection uses the repository name. Do not delete, recreate or rebind it during writes or unresolved operations. Immutable token binding is not verified.'):
        !providerAccepted?el('p',{class:'notice',role:'status'},'Write activation requires the exact protected provider contract from the host operator.'):null,
      status.pending_operation?el('p',{class:'notice',role:'alert'},'An earlier operation needs operator reconciliation. Its request and usage remain retained.'):null,
      el('div',{class:'toolbar'},
        !status.desired_connected?el('button',{disabled:disabled||revoked||failed||token?.configured!==true||!!uncertain,onclick:()=>control('connect')},'Connect repository'):
          !actor?el('button',{disabled:disabled||revoked||failed||!ctx.useAuthoring||!!uncertain,onclick:author},'Use authoring access'):
            el('button',{disabled:disabled||revoked||failed||!status.runtime_ready||!!uncertain,onclick:async()=>{if(busy)return;busy=true;paint();try{await ctx.refreshActor?.(ctx.signal);await ctx.onConnectionChange(status);ctx.navigate('blocks');}catch(error){if(!ctx.signal.aborted){failed=true;feedback.textContent=error.message;}}finally{busy=false;try{valid();paint();}catch{}}}},'Open project')),
      el('details',{},el('summary',{},'Connection tools'),
        el('button',{disabled,onclick:()=>refresh().catch(error=>{failed=true;feedback.textContent=error.message;paint();})},'Refresh status'),
        el('button',{disabled:disabled||revoked||!status.desired_connected||token?.configured!==true||!!status.pending_operation||!!uncertain,onclick:()=>control('test-read')},'Test read access'),
        el('button',{disabled:disabled||revoked||!status.desired_connected||token?.configured!==true||!providerAccepted||!!status.pending_operation||!!uncertain,onclick:()=>control('test-write')},'Test write access'),
        el('button',{disabled:disabled||revoked||!status.desired_connected||!!uncertain,onclick:()=>control('disconnect')},'Pause connection'),
        el('button',{disabled:disabled||revoked||!!uncertain,onclick:()=>control('revoke')},'Revoke access')),
      uncertain?el('button',{disabled,onclick:()=>control(uncertain.action,uncertain)},'Check saved control outcome'):null,
      el('p',{class:'muted'},'Access remains until revoked. Sign-in sessions expire. Pausing, signing in or changing the saved token never resets usage.'),
      feedback)));
  }
  root.credentialChanged=()=>{failed=true;ctx.onConnectionUnavailable?.();feedback.textContent='Token changed. Refresh repository status and use authoring access again.';paint();};
  root.refreshToken=()=>paint();root.append(pane);paint();return root;
}
