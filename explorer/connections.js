import { namespaceSettingsView } from './namespace-settings.js';
import { workspaceSettingsView } from './workspace-settings.js';
import { agentSettings } from './agent-settings.js';
import { agentSetup } from './agent-setup.js';
import { credentialSettings } from './credentials.js';
import { el, pill, fields } from './dom.js';

const sourceFailures={
  SOURCE_AUTH:'Source credentials or the approved read grant need attention. Check the saved token and ask the host operator to confirm the grant.',
  SOURCE_BINDING:'The trusted registry or repository identity could not be verified. Ask the host operator to correct the approved registry, project/model and repository binding, then explicitly Test read before reconnecting.',
  SOURCE_UNAVAILABLE:'The source could not be reached within its bounded read. Check connectivity before explicitly testing again; prior spending remains.',
  READ_SESSION_LIMIT:'This approved grant has exhausted its read budget. Ask the host operator for another approved grant; spending is not reset.',
  READ_BUDGET_UNAVAILABLE:'Protected read accounting needs operator reconciliation. Ask the host operator to reconcile it before testing again.',
  CORRUPT_DATA:'Project records could not be verified. Ask the host operator to correct the approved source, then explicitly Test read before reconnecting.',
  CONNECTION_CHANGED:'The connection changed during the operation. Refresh its current status before another action.',
  CONNECTION_RECOVERY_REQUIRED:'Protected connection state needs operator reconciliation. Ask the host operator to inspect the saved action.'
};
const failureNotice=code=>Object.hasOwn(sourceFailures,code)?`${code}: ${sourceFailures[code]}`:'The source read failed. Ask the host operator to inspect its saved outcome.';
const pendingPrefix='strata-studio-pending-connections/1:';
const isUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function safePending(body){
  if(!body||typeof body!=='object'||!isUuid(body.request_id)||!Number.isSafeInteger(body.revision)||body.revision<0)return false;
  const fields={create:['profile_id','ticket_id','label'],renew:['connection_id','ticket_id'],test:['connection_id'],select:['connection_id'],connect:['connection_id'],disconnect:['connection_id'],remove:['connection_id']}[body.action];
  if(!fields||Object.keys(body).some(key=>!['action','revision','request_id',...fields].includes(key))||fields.some(key=>typeof body[key]!=='string'))return false;
  return fields.every(key=>key.endsWith('_id')&&key!=='profile_id'?isUuid(body[key]):body[key].length>0&&body[key].length<=(key==='label'?128:256));
}

// Host catalog and masked credential metadata. Provider URLs remain on the host.
export function settingsView(ctx){
  const root=el('div',{class:'page connection-settings'}),source=el('div'),credentials=el('div'),agents=el('div');
  let view,credentialView,sourceStatus=null,token=null,started=false,credentialGeneration=0;
  const request=async(route,options={})=>{
    const generation=credentialGeneration;
    const signal=options.method==='POST'?options.signal:AbortSignal.any([ctx.signal,...(options.signal?[options.signal]:[]),AbortSignal.timeout(5000)]);
    let result;try{result=await ctx.request(route,{...options,signal});}catch(error){if(route==='settings'&&options.method!=='POST'&&!ctx.signal.aborted){sourceStatus=null;credentialView?.refreshConnection?.();}if(route==='credentials'&&!ctx.signal.aborted){token={state:'unavailable',configured:null};view?.refreshToken?.();}if(signal?.aborted&&!ctx.signal.aborted&&signal.reason?.name==='TimeoutError'){const timeout=new Error('Status took too long to load. Retry this section.');timeout.code='SETTINGS_TIMEOUT';throw timeout;}throw error;}
    ctx.check();
    if(route==='settings'&&generation!==credentialGeneration){ctx.onConnectionUnavailable?.();const error=new Error(options.method==='POST'?'Token changed while this action was in flight. Check the saved action outcome before continuing.':'Token changed while repository status was loading. Retry this section.');error.code='SETTINGS_TOKEN_CHANGED';throw error;}
    if(route==='settings'){sourceStatus=result;credentialView?.refreshConnection?.();}
    if(route==='credentials'){token={state:result.state,revision:result.revision,configured:result.credentials?.find(c=>c.id==='artifacts-api-token')?.configured??null};if(options.method==='POST'&&['save','remove'].includes(options.body?.action)){credentialGeneration++;if(view)view.credentialChanged?.();else ctx.onConnectionUnavailable?.();}view?.refreshToken?.();}
    return result;
  };
  const child={...ctx,request,getToken:()=>token,getConnectionStatus:()=>sourceStatus,onSettingsRevision:revision=>root.dataset.connectionRevision=String(revision)};
  function loading(holder,title){holder.replaceChildren(el('section',{class:'section'},el('article',{class:'card',role:'status'},el('h2',{},title),el('p',{},'Loading status…'))));}
  async function load(holder,title,build){
    loading(holder,title);
    try{const node=await build();ctx.check();if(!root.isConnected)return;holder.replaceChildren(node);void node.start?.();if(holder===credentials&&token?.state==='unavailable')holder.append(el('button',{onclick:()=>load(holder,title,build)},'Retry token status'));}
    catch(error){if(ctx.signal.aborted)return;ctx.check();if(!root.isConnected)return;holder.replaceChildren(el('section',{class:'section'},el('article',{class:'card'},el('h2',{},title),el('p',{class:'notice',role:'alert'},error.message),el('button',{onclick:()=>load(holder,title,build)},'Retry '+title.toLowerCase()))));}
  }
  const loadSource=()=>load(source,'Repository connection',async()=>{const status=await request('settings',{signal:ctx.signal});view=status.mode==='namespace'?namespaceSettingsView(child,status):status.mode==='workspace'?workspaceSettingsView(child,status):status.format==='strata-studio-owner-connections/1'?managedSettingsView(child,status):legacySettingsView(child,status);return view;});
  root.append(el('div',{class:'heading'},el('div',{},el('div',{class:'eyebrow'},'Studio settings'),el('h1',{tabindex:'-1'},'Connections'))),source,credentials,el('details',{},el('summary',{},'Agent service (optional)'),agents));
  loading(source,'Repository connection');loading(credentials,'Server credentials');loading(agents,'Agent connection');
  root.start=()=>{if(started)return;started=true;void loadSource();void load(credentials,'Server credentials',async()=>credentialView=await credentialSettings(child));void load(agents,'Agent connection',async()=>{try{return await agentSetup(child);}catch(e){if(e.status===404)return agentSettings(child);throw e;}});};
  return root;
}

function tokenLabel(ctx){const token=ctx.getToken();return token?.configured===true?'Saved on server':token?.configured===false?'Not saved':token?'Unavailable — refresh token status':'Checking saved token…';}

function refreshToken(root,ctx){for(const row of root.querySelectorAll('.field'))if(row.querySelector('dt')?.textContent==='API token')row.querySelector('dd').textContent=tokenLabel(ctx);}

function legacySettingsView(ctx,status) {
  const root = el('div', { class: 'connection-panel' });
  let busy = false, unconfirmed=false,operation = null, serial = 0, selection = status.selected_connection_id;
  const feedback = el('p', { role: 'status', 'aria-live': 'polite', class: 'notice' });
  const pane = el('div');
  function valid() { ctx.check(); if (!root.isConnected) throw new DOMException('Interrupted', 'AbortError'); }
  async function reload() {
    try{status = await ctx.request('settings', { signal: ctx.signal }); valid();
    selection = status.selected_connection_id;unconfirmed=false; paint();}
    catch(error){if(ctx.signal.aborted)return;valid();unconfirmed=true;ctx.onConnectionUnavailable?.();paint();throw error;}
  }
  async function run(action) {
    if(busy)return;
    const sequence = ++serial; busy = true; operation = new AbortController();
    const signal = AbortSignal.any([ctx.signal, operation.signal]);
    paint(); feedback.textContent = action === 'test' ? 'Testing the configured read connection…' : 'Updating this local connection session…';
    try {
      status = await ctx.request('settings', { method: 'POST', body: { action, connection_id: action === 'select' ? selection : status.selected_connection_id, revision: status.revision }, signal });
      valid(); if (sequence !== serial) return;
      selection = status.selected_connection_id;
      const current = status.connections.find(c => c.connection_id === selection);
      feedback.textContent = current.error?.message ?? (action === 'test' ? 'Read test passed. No authoring permissions were granted.' : action === 'disconnect' ? 'Disconnected. Cached project views were cleared.' : action === 'select' ? 'Connection selected. Reconnect to verify its read access.' : 'Connected with read-only access.');
      ctx.announce(feedback.textContent);
      await ctx.onConnectionChange(status);
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== serial) return;
      try { valid(); } catch { return; }
      feedback.textContent = error.message;
      // A revision conflict means another session action already won. Reload
      // the host truth before another click; never replay an action automatically.
      if (error.code === 'CONNECTION_CHANGED') { await reload(); await ctx.onConnectionChange(status); }
    } finally {
      if (sequence === serial) { busy = false; operation = null; try { valid(); paint(); } catch {} }
    }
  }
  function cancel() {
    ++serial; operation?.abort(); operation = null; busy = false;
    feedback.textContent = 'Stopped waiting for this operation. Refresh status to see the host result.';
    paint();
  }
  function paint() {
    root.dataset.connectionRevision = String(status.revision);
    ctx.onSettingsRevision(status.revision);
    const current = status.connections.find(c => c.connection_id === status.selected_connection_id);
    const configured = current?.configured;
    const picker = el('select', { id: 'connection-choice', disabled: busy, onchange: event => { selection = event.target.value; paint(); } }, status.connections.map(c => el('option', { value: c.connection_id, selected: selection === c.connection_id }, c.display_name)));
    const rows = [
      ['API token',tokenLabel(ctx)],
      ['State', unconfirmed?'unverified':current?.state ?? 'unavailable'], ['Provider', current?.provider ?? 'unavailable'],
      ['Project', current?.binding?.project_id ?? 'unavailable'], ['Model', current?.binding?.model_version ?? 'unavailable'],
      ['Repository', current?.binding?.repository_identity ? Object.values(current.binding.repository_identity).join(' / ') : current?.provider === 'sample' ? 'Synthetic fixture' : 'Owner setup required'],
      ['Host authentication', current?.authentication ?? 'unknown'],
      ['Registry', current?.verification?.registry_kind ?? 'Unverified'], ['Last verified read', current?.verification?.verified_at ?? 'No read verified'],
      ['Last test', current?.last_test ? current.last_test.outcome + ' · ' + current.last_test.at : 'Not tested'],
    ];
    pane.replaceChildren(
      el('section', { class: 'section', 'aria-labelledby': 'repository-settings' },
        el('h2', { id: 'repository-settings' }, 'Repository connection'),
        el('p', {}, 'Studio and agents use the same Strata repository and its existing ownership, revision and validation rules.'),
        el('div', { class: 'toolbar' }, el('label', { for: 'connection-choice' }, 'Host-configured connection'), picker,
          el('button', { disabled: busy || selection === status.selected_connection_id, onclick: () => run('select') }, 'Use selected connection')),
        el('article', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, current?.display_name ?? 'No connection'), pill(unconfirmed?'Unverified':current?.state ?? 'Unavailable')), fields(rows),
          current?.error ? el('p', { class: 'notice', role: 'alert' }, current.error.message) : null,
          current?.verification?.freshness === 'stale-network' ? el('p', { class: 'notice' }, 'The last verified view is stale. Retry the bounded read test.') : null,
          el('p', {}, !unconfirmed && current?.capabilities.read ? 'Available: inspect published records and refresh. Authoring, proposals, publication, approval and validation are unavailable through this connection.' : 'Project reads are unavailable until the configured connection is verified.'),
          el('div', { class: 'toolbar' },
            el('button', { disabled: busy || unconfirmed||!configured, onclick: () => run('test') }, 'Test read connection'),
            el('button', { disabled: busy || unconfirmed||!configured || !!current?.connected, onclick: () => run('connect') }, current?.connected&&!unconfirmed?'Connected':'Connect repository'),
            el('button', { disabled: busy || !current?.connected, onclick: () => run('disconnect') }, 'Disconnect'),
            el('button', { disabled: busy, onclick: () => reload().then(() => ctx.onConnectionChange(status)).catch(error => { feedback.textContent = error.message; }) }, 'Refresh status'),
            busy ? el('button', { onclick: cancel }, 'Cancel waiting') : null)),
        !configured ? el('p', { class: 'notice' }, 'Owner setup required: supply a trusted project registry, exact repository binding, existing server-side authentication and a bounded read grant to the local Studio host.') : null,
        el('p', { class: 'muted' }, 'Tests perform bounded read verification using the existing adapter and read-session budget. Disconnect clears this Studio session; it does not revoke server credentials. Configuration and credentials stay in the local host.')),
      el('details', { class: 'section' }, el('summary', {}, 'Supported providers'),
        el('ul', {}, status.providers.map(p => el('li', {}, p.label + ' — ' + (!p.supported ? 'Unavailable' : p.configured ? 'Configured · read-only' : 'Supported · owner setup required'))))),
      );
  }
  root.append(feedback, pane);root.refreshToken=()=>refreshToken(root,ctx);root.credentialChanged=()=>{if(status.connections.some(c=>c.connected)){unconfirmed=true;ctx.onConnectionUnavailable?.();feedback.textContent='Token changed. Refresh connection status before connecting again.';paint();}};
  feedback.textContent = 'Connection settings apply to this local session.';
  paint();return root;
}

function managedSettingsView(ctx,initial){
  const root=el('div',{class:'connection-panel'}),pane=el('div'),feedback=el('p',{role:'status','aria-live':'polite',class:'notice'});
  const scope=initial.reconciliation_scope,key=/^[a-f0-9]{64}$/.test(scope?.owner??'')?pendingPrefix+scope.owner:null;
  let status=initial,busy=false,confirming=false,unconfirmed=false,toolsOpen=false,approvedOpen=initial.connections.length===0,abort=null,pending=null,pendingCatalog=null,canRetry=false,profile=status.profiles[0]?.profile_id??'',ticket='',label='';
  try{const raw=key&&sessionStorage.getItem(key);if(raw&&raw.length<=2048){const saved=JSON.parse(raw);if(saved.format==='strata-studio-pending-connection/1'&&!Object.keys(saved).some(k=>!['format','owner','catalog','body'].includes(k))&&saved.owner===scope.owner&&/^[a-f0-9]{64}$/.test(saved.catalog)&&safePending(saved.body)){pending=saved.body;pendingCatalog=saved.catalog;}}}catch{}
  function retain(body){
    if(!key||!safePending(body)||!/^[a-f0-9]{64}$/.test(status.reconciliation_scope?.catalog??''))throw new Error('Current owner/source reconciliation metadata is unavailable. Refresh Settings before dispatching.');
    const saved={format:'strata-studio-pending-connection/1',owner:scope.owner,catalog:status.reconciliation_scope.catalog,body};
    const text=JSON.stringify(saved);
    if(text.length>2048||new TextEncoder().encode(JSON.stringify(body)).byteLength>1024)throw new Error('This connection action is too large. Use a shorter connection label before dispatching.');
    try{sessionStorage.setItem(key,text);}catch{throw new Error('This browser cannot retain the action identity. Enable session storage before dispatching a connection action.');}
    pending=body;pendingCatalog=saved.catalog;
  }
  function resolved(){if(key)try{sessionStorage.removeItem(key);}catch{}pending=null;pendingCatalog=null;canRetry=false;}
  const valid=()=>{ctx.check();if(!root.isConnected)throw new DOMException('Interrupted','AbortError');};
  async function reload(){try{status=await ctx.request('settings',{signal:ctx.signal});valid();unconfirmed=false;paint();await ctx.onConnectionChange(status);}catch(error){if(ctx.signal.aborted)return;valid();unconfirmed=true;canRetry=false;ctx.onConnectionUnavailable?.();feedback.textContent='Connection status could not be verified. '+error.message;paint();}}
  async function run(action,extra={}){
    if(busy)return;
    if(pending&&(extra.request_id!==pending.request_id||pendingCatalog!==status.reconciliation_scope?.catalog)){feedback.textContent='Check the original saved action outcome before another connection action.';return;}
    const body={action,revision:status.revision,request_id:crypto.randomUUID(),...extra};
    try{retain(body);}catch(error){feedback.textContent=error.message;return;}
    canRetry=false;busy=true;abort=new AbortController();paint();feedback.textContent=['test','connect'].includes(action)?'Verifying the approved source within its read budget.':'Saving the approved connection action.';
    try{const next=await ctx.request('settings',{method:'POST',body,signal:AbortSignal.any([ctx.signal,abort.signal])});valid();status=next;if(['completed','failed'].includes(next.outcome?.state))resolved();feedback.textContent=next.outcome?.code?failureNotice(next.outcome.code):action==='test'?'Read test passed. Connection intent is unchanged.':action==='connect'?'Read connection verified.':action==='renew'?'New approved grant activated. Reconnect explicitly.':'Connection action saved.';ctx.announce(feedback.textContent);await ctx.onConnectionChange(status);}
    catch(error){try{valid();}catch{return;}feedback.textContent=error.name==='AbortError'?'Stopped waiting. Check the saved action outcome; dispatched work may have continued.':error.message;
      if(error.status&&error.status<500&&!['CONNECTION_RECOVERY_REQUIRED'].includes(error.code))resolved();
      if(error.code==='OWNER_REAUTH_REQUIRED'&&ctx.reauth){const accepted=await ctx.reauth({signal:ctx.signal});if(ctx.signal.aborted)return;if(accepted){try{status=await ctx.request('settings',{signal:ctx.signal});valid();feedback.textContent='Password confirmed. Choose the connection action again to continue.';}catch(refreshError){if(ctx.signal.aborted)return;valid();unconfirmed=true;canRetry=false;ctx.onConnectionUnavailable?.();feedback.textContent='Password confirmed, but connection status is unavailable. Refresh connection status before another action.';}}else feedback.textContent='Cancelled. No connection or approved grant was changed.';}
      if(error.code==='CONNECTION_CHANGED')await reload();
    }finally{busy=false;abort=null;try{valid();paint();}catch{}}
  }
  async function inspect(){
    if(!pending||busy)return;busy=true;paint();try{const result=await ctx.request('connection-outcome:'+pending.request_id,{signal:ctx.signal});valid();
      if(['completed','failed'].includes(result.state)){resolved();feedback.textContent=result.code?failureNotice(result.code):'Saved action outcome confirmed. No action was replayed.';await reload();}
      else feedback.textContent=result.state==='interrupted'?'The interrupted action needs operator reconciliation.':'The bounded action is still pending. Check again explicitly.';
    }catch(error){canRetry=error.code==='NOT_FOUND'&&pendingCatalog===status.reconciliation_scope?.catalog;feedback.textContent=canRetry?'No saved receipt exists. You may explicitly retry the exact same action.':error.message;}finally{busy=false;try{valid();paint();}catch{}}
  }
  function cancel(){abort?.abort();feedback.textContent='Stopped waiting. Check the saved action outcome before another action.';}
  async function confirm(title,text,action){if(confirming||busy)return;confirming=true;const previous=document.activeElement,dialog=el('dialog',{class:'owner-dialog','aria-labelledby':'connection-confirm-title'});await new Promise(resolve=>{let done=false;const close=()=>{if(done)return;done=true;confirming=false;ctx.signal.removeEventListener('abort',close);dialog.close();dialog.remove();previous?.isConnected&&previous.focus();resolve();};dialog.append(el('h2',{id:'connection-confirm-title'},title),el('p',{},text),el('div',{class:'toolbar'},el('button',{onclick:()=>{close();if(!ctx.signal.aborted)void action();}},title),el('button',{onclick:close},'Cancel')));dialog.addEventListener('cancel',e=>{e.preventDefault();close();});document.body.append(dialog);dialog.showModal();dialog.querySelector('button:last-child').focus();ctx.signal.addEventListener('abort',close,{once:true});});}
  function paint(){
    const focused=document.activeElement,focusId=root.contains(focused)&&['SELECT','INPUT'].includes(focused.tagName)?focused.id:null;
    toolsOpen=root.querySelector('[data-connection-tools]')?.open??toolsOpen;approvedOpen=root.querySelector('[data-approved-repository]')?.open??approvedOpen;
    root.dataset.connectionRevision=String(status.revision);ctx.onSettingsRevision(status.revision);const current=status.connections.find(c=>c.selected),delegated=status.management.state==='delegated',disabled=busy||!!pending||unconfirmed;
    const failure=current?.error?.code??(current?.last_test?.outcome==='failed'?current.last_test.code:null),bindingFailed=['SOURCE_BINDING','CORRUPT_DATA'].includes(failure);
    const choices=status.tickets.filter(t=>t.profile_id===profile&&t.eligible);if(!choices.some(t=>t.ticket_id===ticket))ticket=choices[0]?.ticket_id??'';
    const chosen=choices.find(t=>t.ticket_id===ticket),picker=el('select',{id:'approved-profile',disabled,onchange:e=>{profile=e.target.value;ticket='';paint();}},status.profiles.map(p=>el('option',{value:p.profile_id,selected:p.profile_id===profile},p.label))),grantPicker=el('select',{id:'approved-ticket',disabled,onchange:e=>{ticket=e.target.value;paint();}},choices.map(t=>el('option',{value:t.ticket_id,selected:t.ticket_id===ticket},`${t.requests} requests · ${t.bytes} reserved bytes · expires ${t.expires_at}`)));
    const createForm=el('form',{class:'approved-source-form',onsubmit:e=>{e.preventDefault();void run('create',{profile_id:profile,ticket_id:ticket,label:label.trim()||status.profiles.find(p=>p.profile_id===profile)?.label||'Approved source'});}},
      el('label',{for:'approved-profile'},'Approved repository'),picker,el('label',{for:'approved-ticket'},'Approved read grant'),grantPicker,
      el('label',{for:'approved-label'},'Connection label'),el('input',{id:'approved-label',maxlength:128,value:label,disabled,oninput:e=>label=e.target.value}),
      chosen?el('p',{class:'muted'},`Create uses this exact grant once. It expires ${chosen.expires_at}. No source read occurs until Connect repository or Test read.`):el('p',{class:'notice'},'No eligible unused grant is approved. The host operator must approve another bounded grant.'),el('button',{type:'submit',disabled:disabled||!ticket||!status.management.actions?.includes('create')},'Create connection'));
    const list=el('div',{class:'toolbar'},status.connections.map(c=>el('button',{disabled:disabled||c.selected||!c.actions.select.allowed,onclick:()=>run('select',{connection_id:c.connection_id})},c.selected?`Selected: ${c.display_name}`:`Use ${c.display_name}`)));
    const renewals=current?status.tickets.filter(t=>t.profile_id===current.profile_id&&t.eligible):[];
    const ready=!unconfirmed&&!!current?.runtime_ready;
    const expiry=current?new Date(current.expires_at).toLocaleString():null,expired=current?.error?.code==='SOURCE_AUTH'&&Date.parse(current.expires_at)<=Date.now();
    const guidance=()=>current?unconfirmed?'Refresh connection status to confirm its current state.':expired?'Repository access expired. Your saved token is unchanged. Ask the owner for another approved read grant.':ready?'Your repository is connected. Open the project to read its published records.':failure?'Resolve the error below before connecting.':ctx.getToken()?.configured===false?'No API token is saved. Use Server credentials below, then connect the repository.':current.last_test?.outcome==='passed'?ctx.getToken()?.configured===true?'Read test passed. Connect repository to open the project. No need to enter your token again.':'Read test passed. Connect repository to open the project. Token status is shown below.':'Connect repository to verify access and open the project. Test read alone leaves it disconnected.':delegated?'Choose an approved repository below, then connect it.':'This server needs an approved repository before it can connect.';
    const next=el('p',{class:ready?'':'notice','data-next-action':''},guidance());root.refreshToken=()=>{refreshToken(root,ctx);next.textContent=guidance();};
    pane.replaceChildren(el('section',{class:'section','aria-labelledby':'managed-current'},el('h2',{id:'managed-current'},'Current source'),
      el('article',{class:'card'},el('div',{class:'card-head'},el('h3',{},current?.display_name??'No selected source'),pill(unconfirmed?'Unverified':current?.state??'Setup required')),
        fields([['API token',tokenLabel(ctx)],['Repository access',current?(expired?'Expired at ':'Read only · expires ')+expiry:delegated?'Choose an approved repository':'Host approval required'],['Connection',unconfirmed?'Status unverified':ready?'Connected':current?'Disconnected':'Not selected']]),
        next,
        failure?el('div',{class:'notice',role:'alert'},el('p',{},expired?'The read approval has ended. Connecting requires another approved grant; your stored token has not changed.':sourceFailures[failure]??'The source read failed. Ask the owner to check its saved outcome.'),el('details',{},el('summary',{},'Technical details'),el('code',{},failure))):null,
        el('div',{class:'toolbar'},ready?el('button',{disabled,onclick:async()=>{if(busy)return;busy=true;paint();try{await ctx.onConnectionChange(status);ctx.navigate('blocks');}catch(error){if(!ctx.signal.aborted){busy=false;unconfirmed=true;feedback.textContent=error.message;paint();}}}},'Open project'):el('button',{disabled:disabled||expired||!current||!current.actions.connect.allowed||bindingFailed,onclick:()=>run('connect',{connection_id:current.connection_id})},'Connect repository')),
        el('details',{'data-connection-tools':'',open:toolsOpen},el('summary',{},'Connection details and tools'),
        fields([['Project',current?.binding?.project_id??'No selected project'],['Model',current?.binding?.model_version??'Unavailable'],['Repository',current?.binding?.repository_identity?Object.values(current.binding.repository_identity).join(' / '):'No selected repository'],['Verified snapshot',current?.last_test?.registry_generation??'No exact snapshot retained'],['Owner management',delegated?'Finite source delegation':'Host approval required'],['Source credential','Managed separately below'],['Grant expiry',current?.expires_at??'No active grant'],['Reserved requests',current?.usage.reserved_requests??'Unavailable until protected accounting metadata is supported'],['Reserved bytes',current?.usage.reserved_bytes??'Unavailable'],['Last read test',current?.last_test?`${current.last_test.outcome} · ${current.last_test.at}`:'Not verified']]),
        el('p',{},unconfirmed?'Connection status is unverified. Refresh before reading this project.':ready?'Published records are readable under this approved grant.':'Selection persists. Explicitly reconnect to verify the source; startup and token save do not fetch.'),
        el('div',{class:'toolbar'},...(['test','connect','disconnect'] .map(action=>el('button',{disabled:disabled||!current||!current.actions[action].allowed||(['test','connect'].includes(action)&&expired)||(action==='connect'&&bindingFailed),onclick:()=>run(action,{connection_id:current.connection_id})},{test:'Test read',connect:'Reconnect',disconnect:'Disconnect'}[action]))),
          el('button',{disabled:disabled||!current||!renewals.length||!current.actions.renew.allowed,onclick:()=>confirm('Renew approved grant',`Use the next approved grant: ${renewals[0].requests} requests, ${renewals[0].bytes} reserved bytes, expiry ${renewals[0].expires_at}. Previous spending remains.`,()=>run('renew',{connection_id:current.connection_id,ticket_id:renewals[0].ticket_id}))},'Renew grant'),
          el('button',{disabled:disabled||!current||!current.actions.remove.allowed,onclick:()=>confirm('Remove connection','Remove this visible connection. Approved grant spending and history remain on the server.',()=>run('remove',{connection_id:current.connection_id}))},'Remove connection'))))),
      el('section',{class:'section','aria-labelledby':'approved-connections'},el('h2',{id:'approved-connections'},'Approved repository connections'),list,
        delegated?el('details',{'data-approved-repository':'',open:approvedOpen},el('summary',{},'Add an approved repository'),el('article',{class:'card'},createForm)):el('p',{class:'notice'},'The host operator must approve exact repositories, trusted publication indexes and finite read grants for this owner. Saving an API token does not supply these approvals.')),
      ...(pending?[el('p',{class:'notice'},'Unresolved action: '+pending.action+'. Original request ',el('code',{},pending.request_id),'. Check its saved outcome before another action.')]:[]),
      el('div',{class:'toolbar'},el('button',{disabled:busy,onclick:()=>reload().catch(e=>feedback.textContent=e.message)},'Refresh connection status'),pending&&!busy?el('button',{onclick:inspect},'Check saved action outcome'):null,canRetry&&!busy&&pendingCatalog===status.reconciliation_scope?.catalog?el('button',{onclick:()=>run(pending.action,pending)},'Retry exact action'):null,busy?el('button',{onclick:cancel},'Cancel waiting'):null),
      );
    if(focusId)root.querySelector('#'+CSS.escape(focusId))?.focus({preventScroll:true});
  }
  root.append(feedback,pane);root.refreshToken=()=>refreshToken(root,ctx);root.credentialChanged=()=>{if(status.connections.some(c=>c.runtime_ready)){unconfirmed=true;canRetry=false;ctx.onConnectionUnavailable?.();feedback.textContent='Token changed. Refresh connection status before connecting again.';paint();}};paint();return root;
}
