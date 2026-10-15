import {el,pill,fields} from './dom.js';
import {namespaceFailure} from './connection-feedback.js';
// All provider discovery is an explicit action. Metadata and retained outcomes
// contain no provider token. Lost responses never cause an automatic retry.
export async function repositorySwitcher(ctx){
  const dialog=document.getElementById('menu-dialog'),prior=document.activeElement,content=el('div'),feedback=el('p',{role:'status','aria-live':'polite',tabindex:'-1'});
  let status,token=null,busy=false,busyAction=null,discovery=ctx.discovery??null,pending=null,recovery=null,inspected=null;const search=el('input',{id:'repository-search',type:'search',maxlength:128,placeholder:'Search repositories'});
  const name=el('input',{id:'new-repository-name',required:true,maxlength:128,pattern:'[A-Za-z0-9_\\-]+','aria-describedby':'repository-name-help'}),purpose=el('textarea',{id:'new-project-purpose',required:true,maxlength:500,rows:3});
  name.addEventListener('input',()=>name.setCustomValidity(/^[A-Za-z0-9_-]{1,128}$/.test(name.value)?'':'Use letters, numbers, hyphens or underscores, with no spaces.'));
  const close=el('button',{onclick:()=>dialog.close()},'Close'),cancel=e=>{if(busy&&busyAction!=='discover')e.preventDefault();};
  dialog.replaceChildren(el('div',{class:'dialog-head'},el('h2',{},'Repositories'),close),feedback,content);dialog.setAttribute('aria-label','Repository switcher');dialog.showModal();
  dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',()=>dialog.removeEventListener('cancel',cancel),{once:true});
  dialog.addEventListener('close',()=>prior?.isConnected&&prior.focus(),{once:true});
  const storageKey=()=>`strata-namespace-outcome/1:${status.scope_sha256}`;
  async function refresh(){status=await ctx.request('settings');if(status.mode!=='namespace'){content.replaceChildren(el('p',{},'Namespace repository discovery is not configured on this host. Connection administration is in Settings.'));return;}
    try{token=(await ctx.request('credentials')).credentials?.find(c=>c.id==='artifacts-api-token')?.configured??null;}catch{token=null;}
    try{pending=JSON.parse(sessionStorage.getItem(storageKey())??'null');}catch{}
    const saved=status.operations.find(o=>o.request_id===pending?.request_id);
    if(saved&&['completed','failed'].includes(saved.phase)){sessionStorage.removeItem(storageKey());pending=null;}
    const unfinished=status.operations.find(o=>o.action==='create'&&o.phase==='uncertain');
    if(!pending&&unfinished)pending={request_id:unfinished.request_id,action:'create'};paint();}
  async function run(action,fields={}){
    if(busy||pending&&!['discover','select','recover-create'].includes(action))return;busy=true;busyAction=action;paint();feedback.textContent=['create','recover-create'].includes(action)?'Creating the initial Strata project.':action==='import'?'Verifying existing records and opening the project. Your repository data stays intact.':'Loading repository context.';
    const body={action,revision:status.revision,request_id:crypto.randomUUID(),...fields};
    const track=['create','import','recover-create'].includes(action);
    try{
      // Only the identity and original scope persist, never purpose or draft text.
      if(track){sessionStorage.setItem(storageKey(),JSON.stringify({request_id:body.request_id,action}));pending={request_id:body.request_id,action};}
      const result=await ctx.request('settings',{method:'POST',body,signal:AbortSignal.timeout(70_000)});status=result;
      if(result.outcome?.phase!=='completed')throw Error('This operation needs outcome inspection.');
      if(track){sessionStorage.removeItem(storageKey());pending=null;recovery=null;inspected=null;}
      if(action==='discover'){discovery=result.discovery;feedback.textContent=discovery.repositories.length?'Repository list updated.':'No repositories match this search.';}
      else{await ctx.open(status);dialog.close();}
    }catch(e){feedback.textContent=namespaceFailure(e,action);if(pending){try{const r=await ctx.request('connection-outcome:'+pending.request_id);if(!r.operation||['completed','failed'].includes(r.operation.phase)){sessionStorage.removeItem(storageKey());pending=null;}}catch{}}await refresh().catch(()=>{});}
    finally{busy=false;paint();}
  }
  function forgetPending(requestId){if(pending?.request_id===requestId){sessionStorage.removeItem(storageKey());pending=null;}}
  async function inspect(requestId=pending?.request_id){if(busy||!requestId)return;busy=true;busyAction='inspect-create';recovery=null;inspected=null;paint();feedback.textContent='Checking the repository created by your earlier request.';
    try{const r=await ctx.request('connection-outcome:'+requestId);inspected=r.operation??{request_id:requestId,action:'unknown',phase:'not_found',code:null};
      if(r.operation?.action==='create'&&r.operation.phase==='uncertain'){
        status=await ctx.request('settings',{method:'POST',body:{action:'inspect-create',revision:status.revision,request_id:crypto.randomUUID(),source_request_id:requestId}});recovery=status.recovery;
        inspected=(await ctx.request('connection-outcome:'+requestId)).operation??inspected;
        if(!recovery.repository){forgetPending(requestId);feedback.textContent='No repository was found during this check. Inspect the original outcome below before submitting a new creation.';}
        else feedback.textContent=recovery.can_finish?'The empty repository exists. Finish its Strata setup below.':'The repository has existing content or partially initialized state. It has been preserved; it cannot be initialized as a new empty project.';
      }else if(!r.operation||['completed','failed'].includes(r.operation.phase)){forgetPending(requestId);await refresh();feedback.textContent=r.operation?.phase==='failed'?namespaceFailure({code:r.operation.code},r.operation.action):r.operation?'Repository status updated.':'No saved outcome is visible. This does not prove that no repository was created. Inspect the recovery details below.';}
      else feedback.textContent='The earlier action is still running. Check again shortly.';
    }catch(e){feedback.textContent=namespaceFailure(e,'discover');}finally{busy=false;paint();feedback.focus({preventScroll:true});feedback.scrollIntoView({block:'nearest'});}}
  function recoveryDetails(){
    const project=status.projects.find(p=>p.creation_id===inspected.request_id||p.id===inspected.repository_id),repository=recovery?.repository;
    const packet={format:'strata-studio-repository-recovery/1',original_request_id:inspected.request_id,action:inspected.action,
      repository_name:inspected.repository_name??project?.name??repository?.name??null,original_repository_id:inspected.repository_id??null,
      observed_repository_id:repository?.id??null,outcome:inspected.phase,code:inspected.code??null,retained_project_state:project?.state??null,
      repository_empty:repository?.empty??null,repository_read_only:repository?.read_only??null,can_finish:recovery?.can_finish??false};
    const blocked=recovery&&!recovery.can_finish;
    return el('article',{class:'card','aria-label':'Original repository setup outcome'},el('h3',{},'Original setup outcome'),
      fields([['Original request',packet.original_request_id],['Repository',packet.repository_name??'Not recorded'],['Outcome',packet.outcome],['Recorded reason',packet.code??'None recorded'],['Retained project state',packet.retained_project_state??'Not registered'],['Repository ID',packet.original_repository_id??packet.observed_repository_id??'Not recorded']]),
      blocked?el('p',{class:'notice'},project?.state==='created'?'Studio retained a partially initialized project. Empty-project recovery cannot replace that state.':repository?.read_only?'Cloudflare currently marks this repository read only. Empty-project recovery is unavailable.':repository&&!repository.empty?'This repository already contains content. Empty-project recovery cannot replace it.':'The repository identity or retained state needs reconciliation.'):null,
      blocked||packet.outcome==='not_found'?el('p',{},'Next step: copy these recovery details and give them to the installation operator to reconcile the original request against the retained project state. Keep this repository unchanged until that inspection is complete.'):el('p',{},'These details identify the original action. Inspect them before making another repository decision.'),
      el('button',{disabled:busy,onclick:async()=>{const text=JSON.stringify(packet,null,2);try{await navigator.clipboard.writeText(text);feedback.textContent='Recovery details copied. Share them explicitly with the installation operator; no repository operation was retried.';}catch{content.prepend(el('label',{},'Recovery details to copy',el('textarea',{readonly:true,rows:10,value:text})));feedback.textContent='Clipboard unavailable. Select and copy the recovery details.';}feedback.focus({preventScroll:true});feedback.scrollIntoView({block:'nearest'});}},'Copy recovery details'));
  }
  function paint(){
    close.disabled=busy&&busyAction!=='discover';
    if(!status)return;
    const ready=status.approved&&!status.revoked&&status.connected&&token===true,disabled=busy;
    const rows=discovery?.repositories??status.projects,createOpen=content.querySelector('details')?.open??false;
    content.replaceChildren(...[inspected?recoveryDetails():null,el('p',{class:'muted'},`${status.scope.account} / ${status.scope.namespace}`),
      !status.approved||status.revoked||!status.connected?el('p',{class:'notice'},'Approve or resume this namespace in Settings before opening repositories.'):token!==true?el('p',{class:'notice'},token===false?'Save an Artifacts API token in Settings before discovering or opening repositories.':'Token status is unavailable. Refresh repository status before continuing.'):null,
      el('button',{disabled:busy,onclick:()=>refresh().catch(e=>{feedback.textContent=e.message;})},'Refresh repository status'),
      el('form',{class:'toolbar',onsubmit:e=>{e.preventDefault();void run('discover',{search:search.value,cursor:null});}},el('label',{for:'repository-search'},'Search repositories'),search,el('button',{type:'submit',disabled:disabled||!ready},'Refresh repositories')),
      el('div',{class:'repository-list'},rows.length?rows.map(r=>{const project=status.projects.find(p=>p.id===r.id&&p.name===r.name),canOpen=project?.state==='ready'&&!r.read_only;
        return el('article',{class:'card'},el('div',{class:'toolbar'},el('strong',{},r.name),pill(status.selected_repository_id===r.id?'Selected':canOpen?'Strata project':r.read_only?'Read only in Cloudflare':project?'Opening incomplete':'Existing repository')),
          canOpen?el('button',{disabled:disabled||!ready,onclick:()=>run('select',{repository_id:r.id})},'Open '+r.name):r.read_only?el('p',{class:'muted'},'Cloudflare marks this repository read only. Change the repository setting there to enable Studio drafts.'):project?el('div',{},el('p',{},'Opening did not complete. Inspect its original saved outcome.'),el('button',{disabled:busy,onclick:()=>inspect(project.creation_id)},'Check saved outcome for '+r.name)):el('button',{disabled:disabled||!ready,onclick:()=>importForm(r)},'Open '+r.name));}):el('p',{},'No repositories found. Refresh the list or create a Strata project.')),
      discovery?.next_cursor?el('button',{disabled,onclick:()=>run('discover',{search:search.value,cursor:discovery.next_cursor})},'Next page'):null,
      pending?el('div',{class:'notice'},el('p',{},'An earlier repository setup did not finish. Check it before creating another repository.'),el('button',{disabled:busy,onclick:()=>inspect()},'Check unfinished setup')):null,
      recovery?.can_finish?recoveryForm(ready):null,
      el('details',{open:createOpen},el('summary',{},'New Strata repository'),createForm(ready,disabled||!!pending))].filter(Boolean));
  }
  function recoveryForm(ready){
    const purpose=el('textarea',{id:'recovery-purpose',required:true,maxlength:500,rows:3}),consent=el('input',{id:'recovery-consent',type:'checkbox',required:true});
    return el('form',{class:'card',onsubmit:e=>{e.preventDefault();if(!consent.checked)return;void run('recover-create',{source_request_id:recovery.source_request_id,repository_id:recovery.repository.id,purpose:purpose.value,acknowledgment:'initialize-empty-repository'});}},
      el('h3',{},'Finish '+recovery.repository.name),el('p',{},'Use this existing empty repository. No duplicate repository will be created.'),el('label',{for:purpose.id},'Project purpose'),purpose,
      el('label',{for:consent.id},consent,' Initialize this empty repository as a Strata project.'),el('button',{type:'submit',disabled:busy||!ready},'Finish creating '+recovery.repository.name));
  }
  function importForm(repository){
    const retained=status.importable?.some(i=>i.id===repository.id&&i.name===repository.name),consent=el('input',{type:'checkbox',id:'import-consent'}),file=el('input',{type:'file',accept:'.json,application/json',id:'repository-index'}),message=el('p',{role:'status'});
    const submit=el('button',{type:'submit',disabled:true},'Import and open');
    consent.addEventListener('change',()=>{submit.disabled=!consent.checked;});
    content.replaceChildren(el('h3',{},'Open '+repository.name),el('p',{},retained?'Studio has a saved project index for this repository. It will verify and preserve the existing baseline and drafts.':'Choose the Strata project index JSON file for this repository. The index identifies the exact records; it must not contain credentials.'),
      el('form',{onsubmit:async e=>{e.preventDefault();if(!consent.checked)return;try{
        let index;if(!retained){const selected=file.files?.[0];if(!selected)throw Error('Choose the Strata project index JSON file.');if(selected.size>240*1024)throw Error('The project index must be smaller than 240 KB.');index=JSON.parse(await selected.text());}
        await run('import',{repository_id:repository.id,name:repository.name,...(index?{index}:{}),acknowledgment:'open-snapshot-and-save-new-drafts'});
      }catch(error){message.textContent=error.message;} }},!retained?el('label',{for:file.id},'Strata project index'):null,!retained?file:null,
      el('label',{for:consent.id},consent,' Open these records and let Studio save new drafts. I will keep other writers paused while using Studio.'),
      el('p',{class:'muted'},'Existing drafts keep their original author and publication state. New changes use your Studio identity. Import does not modify remote records.'),submit,el('button',{type:'button',onclick:paint},'Back'),message));
  }
  function createForm(ready,disabled){name.disabled=disabled;purpose.disabled=disabled;
    return el('form',{onsubmit:e=>{e.preventDefault();if(!/^[A-Za-z0-9_-]{1,128}$/.test(name.value)){feedback.textContent='Use letters, numbers, hyphens or underscores for the repository name, with no spaces.';return;}void run('create',{name:name.value,purpose:purpose.value});}},el('label',{for:name.id},'Repository name'),name,el('p',{id:'repository-name-help',class:'muted'},'Letters, numbers, hyphens and underscores only; for example, eleanors-repo-1.'),
      el('label',{for:purpose.id},'Project purpose'),purpose,el('p',{class:'muted'},'Creates a new Strata Block project with unvalidated initial intent. Draft saving is available; independent review and Release roles remain separate.'),
      el('button',{type:'submit',disabled:disabled||!ready},'Create Strata project'));
  }
  try{await refresh();if(!discovery&&!pending&&status.approved&&!status.revoked&&status.connected&&token===true)await run('discover',{search:'',cursor:null});search.focus();}catch(e){feedback.textContent=e.message;}
}
