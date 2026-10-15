import { repositorySwitcher } from './repository-switcher.js';
import { el, pill, fields, empty, welcomeIntro } from './dom.js';
import { blockView, releasePicker } from './blocks.js';
import { layerView, compositionView, evidenceView } from './records.js';
import { compareView } from './compare.js';
import { settingsView } from './connections.js';
import { hostedSession } from './session.js';
import { changesView, reviewView } from './workflow.js';
import { pendingOperation,retainOperation,clearOperation,operationResponse,unconfirmedOperation,sessionRequired } from './operation-recovery.js';
import { agentWorkspace } from './agent-workspace.js';
import { profilesView } from './profiles.js';
import { profileApi } from './profile-api.js';
import { buildView } from './build.js';
import { buildApi } from './build-api.js';

const navGroups=[
  {id:'intent',label:'Intent',sections:['blocks']},
  {id:'proposals',label:'Proposals',sections:['changes','layers']},
  {id:'candidates',label:'Compose & review',sections:['compositions','review','compare']},
  {id:'implementation',label:'Implementation',sections:['profiles','build','evidence']},
  {id:'workspace',label:'Workspace',sections:['agent','settings']}
];
const allowedSections=navGroups.flatMap(group=>group.sections),expandedNavGroups=new Set();
const initial=new URLSearchParams(location.hash.startsWith('#session=')?location.hash.slice(1):location.hash.split('?')[1] ?? '');
let capability=initial.get('session') ?? '';
const hosted=capability ? null : await hostedSession();
let namespaceSelection=null,namespaceProject=null,connectionError=null,draftRecoveryBusy=false,draftRecoveryError=null,sessionEnded=false;
function selectedNamespace(status){namespaceSelection=status.selected_repository_id;namespaceProject=status.projects?.find(p=>p.id===namespaceSelection)??null;}
const sessionHeaders=method=>({... (hosted ? (hosted.projectHeaders??hosted.headers)(method) : {authorization:'Bearer '+capability}),...(hosted?.namespace&&namespaceSelection?{'x-strata-repository':namespaceSelection}:{})});
const sessionCredentials=hosted ? 'same-origin' : 'omit';
initial.delete('session');
// Session capability leaves the address bar immediately and stays in memory only.
if(location.hash.startsWith('#session=')) history.replaceState(null,'',location.pathname+'#/blocks');
else if(capability) history.replaceState(null,'',location.pathname+location.hash.split('?')[0]+(initial.size?'?'+initial:''));
const defaults={section:'blocks',at:'',block:'',item:'',ref:'',type:'',text:'',facets:[],match:'direct',authority:'',all:'false',left:'',right:'',collapsed:[],view:'map',layer:''};
let saved={};try {const p=JSON.parse(localStorage.getItem('strata-explorer-preferences') ?? '{}');for(const key of ['section','at','block','text','facets','match','authority','collapsed'])if(p[key]!==undefined)saved[key]=p[key];}catch{}
let state={...defaults,...saved};
if(!Array.isArray(state.facets))state.facets=[];state.facets=state.facets.filter(f=>['behavior','design','data','safety'].includes(f));
if(!Array.isArray(state.collapsed))state.collapsed=[];
let connection=null,releases=[],workflow=null,epoch=0,controller=null,filterTimer,uniqueId=0;
let activeBuild=null,activeProfiles=null,renderedHash=location.hash,routeRequest=0;
async function leaveProfiles(reason){return !activeProfiles||await activeProfiles.beforeLeave(reason);}
function disposeProfiles(){activeProfiles?.dispose();activeProfiles=null;activeBuild?.dispose();activeBuild=null;}
const announcer=document.getElementById('announcer'), content=document.getElementById('content');
function announce(text){announcer.textContent=text;}
function save(){try {localStorage.setItem('strata-explorer-preferences',JSON.stringify(Object.fromEntries(['section','at','block','text','facets','match','authority','collapsed'].map(key=>[key,state[key]]))));}catch{}}
function href(section,params={}) {
  const q=new URLSearchParams(); const p={...(hosted?.namespace&&namespaceSelection?{repo:namespaceSelection}:{}),at:state.at,...(section==='blocks'?{view:state.view,layer:state.layer}:{}),...params};
  for(const[k,v]of Object.entries(p))if(v!=='' && v!==undefined)q.set(k,String(v));
  return '#/'+section+(q.size?'?'+q:'');
}
function navigate(section,params={}) {const retained=section===state.section?Object.fromEntries(['at','block','item','ref','type','all','left','right','view','layer'].map(key=>[key,state[key]])):{};if(params.at && params.at!==state.at)retained.layer='';location.hash=href(section,{...retained,...params});}
function route() {
  const [section,search]=location.hash.slice(2).split('?');
  state.section=allowedSections.includes(section)?section:'blocks';
  const q=new URLSearchParams(search); for(const k of ['at','block','item','ref','type','all','left','right','view','layer'])state[k]=q.get(k) ?? (k==='at'?state.at:k==='view'?'map':'');
  if(hosted?.namespace&&q.get('repo')&&q.get('repo')!==namespaceSelection){
    ++epoch;controller?.abort();connection=null;releases=[];workflow=null;namespaceSelection=null;namespaceProject=null;connectionError=null;
  }
  save();
}
async function api(route,params={},signal=controller?.signal) {
  const q=new URLSearchParams(params);if(!['connection','refresh'].includes(route))q.set('generation',connection?.source?.registry_generation ?? '');
  const response=await fetch('/explorer/v1/'+route+(q.size?'?'+q:''),{headers:{...sessionHeaders(route==='refresh'?'POST':'GET'),...(route==='refresh'?{'content-type':'application/json'}:{})},method:route==='refresh'?'POST':'GET',body:route==='refresh'?'{}':undefined,cache:'no-store',credentials:sessionCredentials,signal});
  const result=await response.json();
  if(!response.ok) {const error=new Error(result.error?.message ?? 'Studio read failed.');error.code=result.error?.code;error.status=response.status;throw error;}
  return result.data;
}
async function all(route,params,signal) {
  let data=await api(route,{...params,limit:'100'},signal),items=[...data.items];
  while(data.next_cursor) {data=await api(route,{...params,limit:'100',cursor:data.next_cursor},signal);items.push(...data.items);}
  return {...data,items};
}
async function workRead(route,params={},signal=controller?.signal) {
  const query=new URLSearchParams(params), post=['preview','profiles/validate','build/preview'].includes(route);
  const response=await fetch('/studio/v1/'+route+(!post&&query.size?'?'+query:''),{method:post?'POST':'GET',headers:{...sessionHeaders(post?'POST':'GET'),...(post?{'content-type':'application/json'}:{})},body:post?JSON.stringify(params):undefined,cache:'no-store',credentials:sessionCredentials,signal});
  let result;try{result=await response.json();}catch{const e=new Error((response.status===413?'The server rejected this preview at its payload-size limit. ':'Studio returned an unreadable projection response. ')+'(HTTP '+response.status+'). No save was requested by this read.');e.code='STUDIO_RESPONSE_UNAVAILABLE';e.status=response.status;throw e;}
  if(!response.ok){const e=new Error(result.error?.message||'Studio operation unavailable.');e.code=result.error?.code;e.status=response.status;throw e;}return result.data;
}
async function command(command,input,binding,confirm) {
  if(sessionEnded){const error=new Error('Sign in to Studio again before another operation. Your unsaved fields remain in this view.');error.code='SESSION_REQUIRED';throw error;}
  const key=crypto.randomUUID(), pending={key,connection_id:binding.connection_id,command};
  // Only reconciliation metadata persists. Proposed content, sessions and keys do not.
  retainOperation(pending);
  let response;
  try{response=await fetch('/studio/v1/operation',{method:'POST',headers:{...sessionHeaders('POST'),...(hosted?.namespace?{'x-strata-repository':binding.repository_id??binding.connection_id}:{}),'content-type':'application/json'},body:JSON.stringify({command,input,idempotency_key:key,expected_generation:binding.generation,expected_policy:binding.policy}),credentials:sessionCredentials,cache:'no-store',signal:AbortSignal.timeout(hosted?.workspace?65000:30000)});}
  catch{const e=new Error('The outcome is unknown. Reconcile operation '+key+' in this original connection before retrying.');e.code='OPERATION_UNKNOWN';throw e;}
  let result;try{result=await operationResponse(response,key,command);
    if(confirm){let accepted=false;try{accepted=await confirm(result.data,{key,command});}catch{}
      if(!accepted){const error=new Error('The save confirmation did not match its exact draft and repository. Inspect operation '+key+' in Review.');error.code='OPERATION_UNKNOWN';error.outcome_unknown=true;throw error;}}
  }catch(error){
    if(response.status>=500||['OUTPUT_INCOMPLETE','STORE_UNAVAILABLE','BROKER_UNAVAILABLE'].includes(error.code)){error.outcome_unknown=true;error.message+=' Inspect operation '+key+' in Review before another save.';}
    if(!unconfirmedOperation(error)&&response.status<500&&!['OUTPUT_INCOMPLETE','STORE_UNAVAILABLE','BROKER_UNAVAILABLE'].includes(error.code))try{clearOperation(key);}catch{}
    throw error;
  }
  try{clearOperation(key);}catch{}
  if(result.generation&&connection?.connection_id===binding.connection_id){binding.generation=result.generation;connection={...connection,source:{...connection.source,registry_generation:result.generation}};}
  return result;
}
let ownerSettingsMode='unknown';
async function settingsRequest(route,{method='GET',body,signal}={}) {
  const outcome=route.match(/^connection-outcome:([a-f0-9-]{36})$/i);
  const agentOutcome=route.match(/^agent-outcome:([a-f0-9-]{36})$/i),agent=route==='agents'||!!agentOutcome;
  if(!['settings','credentials','agents'].includes(route)&&!outcome&&!agentOutcome)throw new Error('Unsupported settings route.');
  const owner=hosted?.mode==='hosted-owner';
  if(outcome&&(!owner||method!=='GET'))throw new Error('Action outcome requires the owner session.');
  if(agent&&(!owner||(agentOutcome&&method!=='GET')))throw new Error('Agent settings require the owner session.');
  const managed=owner&&ownerSettingsMode!=='legacy';
  const response=await fetch(agentOutcome?'/studio/v1/owner/agents/operations/'+agentOutcome[1]:route==='agents'?'/studio/v1/owner/agents':outcome?'/studio/v1/owner/connections/operations/'+outcome[1]:route==='credentials'?(owner?'/studio/v1/owner/credentials':'/studio/v1/credentials'):managed?'/studio/v1/owner/connections':'/explorer/v1/settings',{method,headers:{...(hosted?hosted.headers(method):sessionHeaders(method)),...(method==='POST'?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:sessionCredentials,signal});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error?.message ?? 'Connection settings failed.');error.code=result.error?.code;error.status=response.status;throw error;}
  if(route==='settings'&&managed&&method==='GET'&&result.mode==='legacy'){ownerSettingsMode='legacy';return settingsRequest(route,{method,body,signal});}
  return agent||route==='credentials'||managed?result:result.data;
}
async function agentRequest(route,{method='GET',body,signal=controller?.signal}={}) {
  if(hosted?.mode!=='hosted-owner')throw new Error('Agent workflows require the installation owner.');
  if(!/^(connections|conversations\?baseline=[^&]+|conversations\/[a-f0-9-]{36}|operations\/[a-f0-9-]{36})$/i.test(route))throw new Error('Unsupported agent route.');
  const response=await fetch('/studio/v1/owner/agent-'+route,{method,headers:{...hosted.headers(method),...(method==='POST'&&hosted.projectHeaders?{'x-studio-actor-csrf':hosted.projectHeaders('POST')['x-studio-csrf']??''}:{}),...(namespaceSelection?{'x-strata-repository':namespaceSelection}:{}),...(method==='POST'?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(method==='GET'?10000:120000)])});
  let result;try{result=await response.json();}catch{throw new Error('The agent outcome is unknown. Inspect its original operation before retrying.');}
  if(!response.ok){const error=new Error(result.error?.message??'Agent operation unavailable.');error.code=result.error?.code;error.status=response.status;error.before_admission=result.error?.before_admission===true;throw error;}return result;
}
async function connectionChanged(settings) {
  disposeProfiles();
  const previous=connection;if(settings.mode==='namespace')selectedNamespace(settings);connectionError=null;
  content.setAttribute('aria-busy','true');
  ++epoch;controller?.abort();controller=new AbortController();
  document.querySelectorAll('dialog[open]').forEach(dialog=>{if(settings.mode!=='namespace'||dialog.id!=='menu-dialog')dialog.close();});
  window.dispatchEvent(new CustomEvent('strata:connection-change',{detail:{revision:settings.revision,connection_id:settings.selected_connection_id}}));
  connection=null;releases=[];workflow=null;
  try {connection=await api('connection',{},controller.signal);if(connection.ready)releases=(await all('records',{type:'release'},controller.signal)).items;}catch(error){if(error.name==='AbortError')return;if(settings.mode==='namespace'){connectionError=error;throw error;}}
  if(!connection?.ready || connection.connection_id!==previous?.connection_id || connection.source?.registry_generation!==previous?.source?.registry_generation)state.layer='';
  if(!releases.some(r=>r.ref===state.at)){state.at='';state.block='';state.item='';state.ref='';state.left='';state.right='';}
  if(hosted?.namespace&&!state.at&&releases.length===1)state.at=releases[0].ref;
  save();
  await render();
}
const ctxBase={get state(){return state;},get releases(){return releases;},href,navigate,save,announce,unique:()=>++uniqueId,copy:async()=>{const text=location.origin+location.pathname+href(state.section,Object.fromEntries(['at','block','item','ref','type','left','right','all'].map(k=>[k,state[k]])));try {await navigator.clipboard.writeText(text);announce('Exact reference copied.');}catch{announce('Copy unavailable. The address bar contains the public route without a session capability.');}},filter:(patch,focus)=>{Object.assign(state,patch);save();clearTimeout(filterTimer);filterTimer=setTimeout(()=>render(focus),180);}};
function icon(kind) {
  const paths={
    blocks:'M3 3h12v12H3z',
    changes:'M3 12.5V15h2.5L15 5.5 12.5 3z M10.5 5l2.5 2.5',
    review:'M6 3H4v13h10V3h-2 M6 2h6v3H6z M6 10l2 2 4-4',
    profiles:'M3 4h3 M10 4h5 M6 2v4h4V2z M3 9h7 M14 9h1 M10 7v4h4V7z M3 14h1 M8 14h7 M4 12v4h4v-4z',
    build:'M10 2l6 6-2 2-6-6z M10 6l-7 7 2 2 7-7',
    layers:'M3 12l3-8h11l-3 8z',
    compositions:'M3 3h12v12H3z M3 9h12 M9 3v12',
    compare:'M3 5h12l-3-3 M15 13H3l3 3',
    evidence:'M9 3a6 6 0 1 0 0 12a6 6 0 0 0 0-12 M9 6a3 3 0 1 0 0 6a3 3 0 0 0 0-6',
    agent:'M4 5h10v10H4z M9 2v3 M1.5 8v4 M16.5 8v4 M6 8h1 M11 8h1 M6 12h6',
    settings:'M7 2h4v2l2 1 2-1 2 3-2 1v2l2 1-2 3-2-1-2 1v2H7v-2l-2-1-2 1-2-3 2-1V8L1 7l2-3 2 1 2-1z M9 6a3 3 0 1 0 0 6a3 3 0 0 0 0-6'
  };
  return el('svg',{class:'nav-icon',viewBox:'0 0 18 18','aria-hidden':'true'},el('path',{d:paths[kind] ?? 'M3 4h12 M3 9h12 M3 14h12',fill:'none',stroke:'currentColor','stroke-width':'1.2'}));
}
function toggleNavGroup(event,group){
  event.preventDefault();
  if(group.sections.includes(state.section))return;
  const open=!expandedNavGroups.has(group.id);
  if(open)expandedNavGroups.add(group.id);else expandedNavGroups.delete(group.id);
  document.querySelectorAll('.nav-group[data-nav-group="'+group.id+'"]').forEach(node=>{node.open=open;});
}
function nav(){
  return el('nav',{class:'project-nav','aria-label':'Project sections'},navGroups.map(group=>
    el('details',{class:'nav-group','data-nav-group':group.id,open:expandedNavGroups.has(group.id)||group.sections.includes(state.section)},
      el('summary',{onclick:event=>toggleNavGroup(event,group)},group.label,
        el('svg',{class:'nav-chevron',viewBox:'0 0 18 18','aria-hidden':'true'},el('path',{d:'M6 4l5 5-5 5',fill:'none',stroke:'currentColor','stroke-width':'1.2'}))),
      el('div',{class:'nav-group-links'},group.sections.map(section=>
        el('a',{href:href(section),'aria-current':state.section===section?'page':undefined,onclick:()=>document.getElementById('menu-dialog').close()},icon(section),section.charAt(0).toUpperCase()+section.slice(1)))))));
}
async function openRepositories(discovery){
  if(!await leaveProfiles('repository-switch'))return;
  await repositorySwitcher({discovery:Array.isArray(discovery?.repositories)?discovery:null,request:settingsRequest,open:async status=>{
    selectedNamespace(status);connectionError=null;await hosted.useAuthoring();
    state={...defaults,section:'blocks'};history.replaceState(null,'',location.pathname+'#/blocks?repo='+encodeURIComponent(namespaceSelection));
    await connectionChanged(status);
  }});
}
async function resumeDraftSaving(){
  if(draftRecoveryBusy)return;draftRecoveryBusy=true;draftRecoveryError=null;shell();
  try{
    const repository=namespaceSelection,status=await settingsRequest('settings');
    if(status.selected_repository_id!==repository)throw Error('The selected repository changed. Open it again before resuming draft saving.');
    const result=await settingsRequest('settings',{method:'POST',body:{action:'resume-drafts',repository_id:repository,revision:status.revision,request_id:crypto.randomUUID()},signal:AbortSignal.timeout(70000)});
    await hosted.useAuthoring();await connectionChanged(result);announce('Draft saving is enabled. Your existing records were preserved.');
  }catch(error){draftRecoveryError=error.message;}
  finally{draftRecoveryBusy=false;shell();}
}
function shell() {
  const source=connection?.source;
  const sourceText=sessionEnded?'Sign-in required':source?.mode==='local-broker'?'Connected project':source?.mode==='sample'?'Sample data':source?.mode==='artifacts-remote'?source.registry_kind==='fixed-snapshot'?'Artifacts · fixed registry snapshot':'Artifacts · verified read':hosted?.namespace&&!connection?'Choose repository':!connection&&state.section==='settings'?'Check connection below':'Not connected';
  if(hosted?.namespace){
  document.getElementById('header').replaceChildren(el('div',{class:'brand'},el('svg',{viewBox:'0 0 28 34','aria-hidden':'true'},el('path',{d:'M2 9l12-6 12 6-12 6z M2 17l12 6 12-6 M2 25l12 6 12-6',fill:'none',stroke:'currentColor','stroke-width':'1.8'})),el('span',{},'strata'),el('small',{},'Studio')),el('button',{class:'project-label repository-switcher',onclick:hosted?.mode==='hosted-owner'?openRepositories:connectionDetails,'aria-haspopup':'dialog'},(connection?.display_name ?? namespaceProject?.name ?? 'Choose repository')+' ▾'),el('div',{class:'header-actions'},el('span',{class:'source-badge'},sourceText),pill(sessionEnded?'Draft saving disabled':hosted?.namespace&&!namespaceSelection?'No repository selected':workflow?.write_blocked?'Draft saving paused':workflow?.write_configured?'Draft editing enabled':connection?.ready?'Viewing repository':connectionError?'Repository needs attention':'Opening repository...'),el('button',{class:'text-button',id:'refresh',onclick:refresh},'Refresh')));
  }else{
  document.getElementById('header').replaceChildren(el('div',{class:'brand'},el('svg',{viewBox:'0 0 28 34','aria-hidden':'true'},el('path',{d:'M2 9l12-6 12 6-12 6z M2 17l12 6 12-6 M2 25l12 6 12-6',fill:'none',stroke:'currentColor','stroke-width':'1.8'})),el('span',{},'strata'),el('small',{},'Studio')),el('span',{class:'project-label'},connection?.display_name ?? namespaceProject?.name ?? 'Local project browser'),el('button',{class:'mobile-only menu-button',onclick:()=>{const dialog=document.getElementById('menu-dialog');dialog.replaceChildren(el('div',{class:'dialog-head'},el('h2',{},'Project menu'),el('button',{onclick:()=>dialog.close()},'Close')),nav());dialog.showModal();}},'Menu'),el('div',{class:'header-actions'},el('span',{class:'source-badge'},sourceText),pill(workflow?.write_configured?'Configured actor':'Read only'),el('button',{class:'text-button',onclick:connectionDetails},'Connection details'),el('button',{class:'text-button',id:'refresh',onclick:refresh},'Refresh')));
  }
  document.getElementById('sidebar').replaceChildren(el('div',{class:'sidebar-head'},el('div',{class:'eyebrow'},'Project'),el('strong',{},connection?.display_name ?? namespaceProject?.name ?? 'Local project browser'),el('p',{class:'muted'},connection?.scope ?? (hosted?.namespace?'Project records and owned drafts':'Published project records'))),nav(),el('div',{class:'sidebar-foot'},el('div',{class:'eyebrow'},'Local project browser'),el('p',{},'Inspect intent and its recorded decisions.'),el('p',{},sourceText)));
  document.getElementById('banner').replaceChildren(...(sessionEnded?[sessionRecovery(el('div',{class:'notice',role:'status'},el('p',{},'Studio session ended. Draft saving is disabled until you sign in and reopen the saved view.')))]:[]),...(workflow?.write_message?[el('div',{class:'notice',role:'status'},el('p',{},draftRecoveryBusy?'Checking repository access and safely restoring draft saving…':draftRecoveryError??workflow.write_message),workflow.write_recovery_available?el('button',{disabled:draftRecoveryBusy,onclick:resumeDraftSaving},draftRecoveryBusy?'Resuming…':'Resume draft saving'):null)]:[]),...(hosted?.namespace&&connection?.ready&&connection?.model_version==='strata/0.3-block-lifecycle-experimental'?[el('div',{class:'notice',role:'status'},'Bootstrap baseline — no validation evidence. Saved changes remain proposals until independently reviewed.')]:[]),...(connection?.draft_review ? [el('div',{class:'notice',role:'status'},'Owner-authorized draft review: '+connection.draft_review.ref+' - unpublished; review required.')] : []),...(source?.freshness==='stale-network'?[el('div',{class:'notice',role:'status'},`Could not refresh Artifacts. Showing the last verified view from ${source.verified_at}; it may be out of date.`)]:[]));
  if(!hosted?.namespace)document.querySelector('#header .header-actions').append(el('button',{class:'text-button',onclick:()=>navigate('settings')},'Settings'));
  if(hosted?.namespace){let mobile=document.getElementById('mobile-project-sections');if(!mobile){mobile=el('div',{id:'mobile-project-sections',class:'mobile-only'});document.getElementById('header').after(mobile);}mobile.replaceChildren(nav());}
  if(hosted){document.querySelector('#header .brand small').textContent='Studio';document.querySelector('#header .header-actions').append(el('button',{class:'text-button',onclick:()=>hosted.logout().catch(error=>announce(error.message))},'Sign out'));}
}
function connectionDetails() {
  const dialog=document.getElementById('connection-dialog'), source=connection?.source;
  dialog.replaceChildren(el('div',{class:'dialog-head'},el('h2',{id:'connection-title'},'Connection details'),el('button',{onclick:()=>dialog.close()},'Close')),fields([['Project',connection?.project_id ?? 'Unavailable'],['Connection',connection?.connection_id ?? 'Unavailable'],['Source',source?.mode ?? 'Not connected'],['Configured repository',connection?.repository_identity?el('code',{},Object.values(connection.repository_identity).join(' / ')):'No Artifacts repository configured'],['Registry',source?.registry_kind ?? 'Trusted Strata registry required'],['Registry generation',el('code',{},source?.registry_generation ?? 'None verified')],['Last verified read',source?.verified_at ?? 'No read verified'],['Freshness',source?.freshness ?? 'Unavailable'],['Model',el('code',{},connection?.model_version ?? 'Unavailable')],['Scope',connection?.scope ?? 'Published project records'],['Trust',source?.semantic_trust??'Unavailable'],['Current mediation checks','Unavailable']]),el('p',{class:'muted'},'Observation time describes the host read, not record creation or new validation.'),el('p',{},connection?.draft_review ? 'This local session also reads one exact owner-authorized unpublished draft. Its publication and approval state remain unchanged.' : 'Changes and approvals happen through the Strata authoring workflow.'),el('p',{},'Connection setup stays in the local host. Supply the trusted publication registry and an already approved Artifacts read credential provider. Protected sign-in and server credential management depend on explicit owner configuration.'),!source?el('p',{},'Next owner step: identify the exact trusted project registry and confirm an existing Artifacts > Read authentication scope before authorizing a bounded read. Enter secrets only through the protected Server credentials form in Settings.'):null);
  dialog.showModal();
}
async function refresh() {
  if(!await leaveProfiles('refresh'))return;
  disposeProfiles();
  window.dispatchEvent(new Event('strata:view-change'));
  const button=document.getElementById('refresh');button.disabled=true;button.textContent='Refreshing…';content.setAttribute('aria-busy','true');announce('Refreshing the exact registry view.');
  // Invalidate all in-flight view requests before replacing a generation.
  ++epoch;controller?.abort();controller=new AbortController();
  try {connection=await api('refresh',{},controller.signal);releases=(await all('records',{type:'release'},controller.signal)).items;shell();await render(undefined,true);}
  catch(error) {
    if(error.name==='AbortError')return;
    try {connection=await api('connection',{},undefined);}catch{connection=null;}
    if(!connection?.ready) {releases=[];showError(error);}
    shell();if(connection?.ready)announce(error.message);else showError(error);
  } finally {content.removeAttribute('aria-busy');const refresh=document.getElementById('refresh');if(refresh){refresh.disabled=false;refresh.textContent='Refresh';refresh.focus({preventScroll:true});}}
}
function sessionRecovery(target){
  target.append(el('p',{},'Your unsaved fields remain in this view. Copy unsaved edits before refreshing; refreshing discards those inputs.'),hosted?el('a',{href:location.href,target:'_blank',rel:'noopener'},'Sign in in another tab'):el('p',{},'Open a new local Studio session before making another operation.'));
  return target;
}
function endSession(ctx){
  sessionEnded=true;workflow=null;connection=connection?{...connection,source:null,ready:false}:null;
  if(ctx){ctx.workflow=null;ctx.connection=connection;}
  shell();document.querySelectorAll('button[data-studio-command]').forEach(button=>button.disabled=true);
}
function showError(error) {
  const signin=sessionRequired(error);if(signin)endSession();
  // A private reference refusal is local to that view, not a source failure.
  if(error.status===401||[403,422].includes(error.status)&&error.code!=='REF_NOT_FOUND') {connection=connection?{...connection,source:null,ready:false}:null;releases=[];workflow=null;}
  shell();
  const titles={SESSION_REQUIRED:'Open a new local session.',SOURCE_AUTH:'Source access needs attention.',SOURCE_BINDING:'Project source does not match.',CORRUPT_DATA:'Project records could not be verified.',REF_NOT_FOUND:'This reference is unavailable.',STALE_GENERATION:'The record list changed.',STALE_CURSOR:'The record list changed.',READ_LIMIT:'This project exceeds the current Studio read limit.',VIEW_TOO_LARGE:'This detail exceeds the current view limit.'};
  content.replaceChildren(el('div',{class:'welcome',role:'alert'},el('h1',{tabindex:'-1'},hosted && signin ? 'Sign in to Studio again.' : titles[error.code] ?? 'Connection not ready.'),el('p',{},error.message),error.code==='REF_NOT_FOUND'&&connection?.ready?el('div',{},el('p',{},'This refusal applies to the requested reference. The selected repository remains available. Imported drafts keep their recorded author; their workflow Review page is available to that author.'),el('a',{href:href('layers',{ref:'',type:''})},'Browse visible Layers')):null,hosted && signin ? el('button',{onclick:()=>location.reload()},'Sign in') : el('button',{onclick:connectionDetails},'Connection details'),releases.length?releasePicker(ctxBase):null));content.querySelector('h1')?.focus();announce(error.message);
}
async function render(focusId,preserve=false) {
  disposeProfiles();renderedHash=location.hash;
  window.dispatchEvent(new Event('strata:view-change'));
  const generation=++epoch;controller?.abort();controller=new AbortController();const signal=controller.signal;
  const position=window.scrollY, focused=document.activeElement?.id;
  content.setAttribute('aria-busy','true');announce('Loading exact project view.');
  workflow=null;if(connection?.ready)try{workflow=await workRead('capabilities',{},signal);}catch(error){if(error.name==='AbortError')return;}
  if(generation!==epoch)return;shell();
  const binding={connection_id:connection?.connection_id,repository_id:connection?.repository_id??namespaceSelection,generation:connection?.source?.registry_generation,policy:workflow?.policy_generation};
  const ctx={...ctxBase,signal,agentRequest:async(route,options={})=>{try{return await agentRequest(route,{...options,signal:options.signal??signal});}catch(error){if(generation===epoch&&sessionRequired(error))endSession(ctx);throw error;}},reauth:hosted?.reauth,refreshActor:hosted?.refreshActor,owner:hosted?.mode==='hosted-owner',agentSaved:value=>{const next=value?.generation;if(generation===epoch&&connection?.connection_id===binding.connection_id&&/^[a-f0-9]{64}$/.test(next??'')){connection={...connection,source:{...connection.source,registry_generation:next}};binding.generation=next;}},state:{...state,project_id:connection?.project_id,repository_id:connection?.repository_id??namespaceSelection},releases,connection,workflow,pendingOperation,clearOperation,sessionRecovery,workRead:async(route,params,options={})=>{try{return await workRead(route,params,options.signal?AbortSignal.any([signal,options.signal]):signal);}catch(error){if(generation===epoch&&sessionRequired(error))endSession(ctx);throw error;}},command:async(name,input,options={})=>{ctx.check();try{return await command(name,input,binding,options.confirm);}catch(error){if(generation===epoch&&sessionRequired(error))endSession(ctx);throw error;}},reload:()=>refresh(),save:()=>{if(generation===epoch){state.collapsed=ctx.state.collapsed;save();}},api:(route,params)=>api(route,params,signal),all:(route,params)=>all(route,params,signal),check:()=>{if(generation!==epoch)throw new DOMException('Interrupted','AbortError');}};
  ctx.profileBinding=async(options={})=>{
    ctx.check();const scopedSignal=options.signal?AbortSignal.any([signal,options.signal]):signal;
    const next=await api('refresh',{},scopedSignal),caps=await ctx.workRead('capabilities',{},options);ctx.check();
    if(next.connection_id!==binding.connection_id||next.project_id!==ctx.state.project_id||ctx.state.repository_id&&next.repository_id&&next.repository_id!==ctx.state.repository_id)throw Error('The repository changed. Reopen Profiles in its original repository.');
    connection=next;ctx.connection=next;workflow=caps;ctx.workflow=caps;binding.generation=caps.generation;binding.policy=caps.policy_generation;shell();
  };
  ctx.recoverProfilesSession=async()=>{
    ctx.check();
    if(hosted?.refreshActor){const recovered=await hosted.refreshActor(signal);if(!recovered.authenticated)await hosted.useAuthoring(signal);}
    else if(hosted?.refreshSession){if(!await hosted.refreshSession(signal))return false;}
    else return false;
    if(ctx.profilePrincipal&&hosted?.principalId!==ctx.profilePrincipal)return false;
    await ctx.profileBinding();ctx.check();sessionEnded=false;shell();return true;
  };
  ctx.profilePrincipal=hosted?.principalId;
  ctx.buildDownload=async(input,options={})=>{
    ctx.check();
    if(![input.build_id,input.file_id].every(id=>/^[a-f0-9]{64}$/.test(id??'')))throw Error('Choose an exact build and opaque output file.');
    const query=new URLSearchParams(input);
    const response=await fetch('/studio/v1/build/output?'+query,{headers:sessionHeaders('GET'),credentials:sessionCredentials,cache:'no-store',signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
    ctx.check();
    if(!response.ok){let reply;try{reply=await response.json();}catch{}const error=new Error(reply?.error?.message??'Output download unavailable.');error.code=reply?.error?.code;error.status=response.status;if(sessionRequired(error))endSession(ctx);throw error;}
    const blob=await response.blob();ctx.check();return blob;
  };
  try {
    if(state.section==='settings') {
      const view=await settingsView({...ctx,signal,owner:hosted?.mode==='hosted-owner',request:settingsRequest,reauth:hosted?.reauth,useAuthoring:hosted?.useAuthoring,refreshActor:hosted?.refreshActor,openRepositories,onConnectionChange:connectionChanged,onConnectionUnavailable:()=>{connection=null;releases=[];workflow=null;shell();}});
      ctx.check();content.replaceChildren(view);view.start();window.scrollTo({top:0});content.querySelector('h1')?.focus({preventScroll:true});announce('Connection settings opened. Loading status.');
      return;
    }
    if(!connection?.ready&&hosted?.namespace&&namespaceSelection){showError(connectionError??new Error('The selected repository could not be loaded. Open it again from the repository selector.'));return;}
    if(!connection?.ready&&hosted?.namespace){content.replaceChildren(el('div',{class:'welcome'},el('h1',{},'Choose a Strata repository.'),el('p',{},'Open an existing repository or create a new Strata project in your Artifacts namespace.'),el('button',{onclick:openRepositories},'Choose repository'),el('p',{},'Connection approval and API token administration are in Settings.')));return;}
    if(!connection?.ready) {const error=new Error(connection?.error?.message ?? 'Configure a trusted Strata registry and an existing Artifacts read connection in the local host.');error.code=connection?.error?.code;showError(error);return;}
    if(state.section==='build'){
      const view=buildView({...ctx,buildApi:buildApi(ctx),sessionRecovery:ctx.recoverProfilesSession});ctx.check();activeBuild=view;content.replaceChildren(view);await view.start();ctx.check();window.scrollTo({top:0});content.querySelector('h1')?.focus({preventScroll:true});announce('Build loaded.');return;
    }
    if(state.section==='profiles'){
      const view=profilesView({...ctx,profileApi:profileApi(ctx),sessionRecovery:ctx.recoverProfilesSession});ctx.check();activeProfiles=view;content.replaceChildren(view);await view.start();ctx.check();window.scrollTo({top:0});content.querySelector('h1')?.focus({preventScroll:true});announce('Profiles loaded.');return;
    }
    if(state.section==='agent'){const view=await agentWorkspace(ctx);ctx.check();content.replaceChildren(view);content.querySelector('h1')?.focus({preventScroll:true});return;}
    if(['changes','review'].includes(state.section)){const view=await (state.section==='changes'?changesView:reviewView)(ctx);ctx.check();content.replaceChildren(view);window.scrollTo({top:0});content.querySelector('h1')?.focus({preventScroll:true});announce(state.section+' loaded.');return;}
    if(state.at && !releases.some(r=>r.ref===state.at)) {const e=new Error('Choose another visible exact Release.');e.code='REF_NOT_FOUND';throw e;}
    let view;
    if(state.section!=='blocks' && !state.at && !state.ref && state.section!=='compare') view=el('div',{class:'welcome'},el('h1',{tabindex:'-1'},'Choose a Release to explore.'),welcomeIntro(),releasePicker(ctx));
    else view=await ({blocks:blockView,layers:layerView,compositions:compositionView,compare:compareView,evidence:evidenceView}[state.section])(ctx);
    ctx.check();content.replaceChildren(view);
    if(focusId){const input=document.getElementById(focusId);input?.focus({preventScroll:true});if(input?.setSelectionRange)input.setSelectionRange(input.value.length,input.value.length);}
    else if(preserve){window.scrollTo({top:position});document.getElementById(focused)?.focus({preventScroll:true});}
    else {window.scrollTo({top:0});(content.querySelector('#focused-block-title') ?? content.querySelector('h1'))?.focus({preventScroll:true});if(state.block && state.view!=='outline' && matchMedia('(max-width:1000px)').matches)content.querySelector('.focused-block')?.scrollIntoView({block:'start'});if(/^(requirements|acceptance)\.[A-Za-z0-9_.-]+$/.test(state.item)){const [collection,...key]=state.item.split('.');const target=document.getElementById((collection==='requirements'?'requirement-':'acceptance-')+key.join('.'));target?.scrollIntoView({block:'center'});target?.focus({preventScroll:true});}}
    announce(`${state.section} loaded${state.at?' at '+state.at:''}${state.block?' · '+state.block:''}.`);
  } catch(error) {if(error.name!=='AbortError' && generation===epoch)showError(error);}
  finally {if(generation===epoch)content.removeAttribute('aria-busy');}
}
window.addEventListener('hashchange',async()=>{const request=++routeRequest,previous=renderedHash;
  const leave=await leaveProfiles('navigation');if(request!==routeRequest)return;
  if(!leave){history.replaceState(null,'',location.pathname+previous);return;}
  clearTimeout(filterTimer);document.getElementById('blocks-dialog').close();route();void render();
});
window.addEventListener('beforeunload',event=>{if(activeProfiles?.hasUnsavedChanges()){event.preventDefault();event.returnValue='';}});
try {
  if(hosted?.namespace){
    const ns=await settingsRequest('settings');selectedNamespace(ns);
    const requested=initial.get('repo');if(requested&&requested!==namespaceSelection){namespaceSelection=null;namespaceProject=null;}
  }
  route();
  // Hydrate the selected project even when the entry page is Settings. Hash
  // navigation must not leave a selected repository with an empty read context.
  if(!hosted?.namespace||namespaceSelection){
    try{
      if(hosted?.namespace)await hosted.useAuthoring();
      connection=await api('connection');
      if(connection.ready)releases=(await all('records',{type:'release'})).items;
      if(!state.at&&connection.initial_release_ref)state.at=connection.initial_release_ref;
      if(hosted?.namespace&&releases.length===1&&!releases.some(r=>r.ref===state.at))state.at=releases[0].ref;
    }catch(error){connectionError=error;if(!hosted?.namespace&&state.section!=='settings')throw error;}
  }
  route();await render();
} catch(error) {connectionError=error;route();if(state.section==='settings'||hosted?.namespace)await render();else showError(error);}
