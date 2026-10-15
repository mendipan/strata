import { el, pill, fields, raw, empty, heading } from './dom.js';
import { proposalCard, readableValue } from './readable.js';
import { openProposal, modal, copyText } from './proposals.js';
import { normalizedDraft, authoringHandoff, inspectAuthoringHandoff, typedBlockRequirement } from './draft-model.js';
import { unconfirmedOperation,sessionRequired } from './operation-recovery.js';

export function permits(ctx, command) {
  return !!ctx.workflow?.operations?.some(o => o.operation === command && o.supported!==false && o.authorized && o.configured);
}
function action(ctx, command, name, input, output) {
  const button = el('button', { type: 'button', 'data-studio-command':command, disabled: !permits(ctx, command), title: permits(ctx, command) ? '' : 'This session has no configured grant for '+command }, name);
  button.addEventListener('click', async () => {
    button.disabled = true;
    let body;
    try {
      ctx.check();
      body = typeof input === 'function' ? input() : input;
      const result = await ctx.command(command, body);
      const savedRevision=['layer.revise','layer.restore'].includes(command)&&typeof result.data.ref==='string'?result.data.ref:null;
      output.replaceChildren(el('p', { role: 'status' }, result.data.ref ? 'Saved '+result.data.ref : 'Operation completed.'), raw(result.data), el('button', { onclick: () => savedRevision&&savedRevision!==ctx.state.ref?ctx.navigate('review',{ref:savedRevision}):ctx.reload() }, 'Reload saved view'));
      output.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      const alert=el('p', { role: 'alert', class: 'form-error',tabindex:'-1' }, (error.code ? error.code+': ' : '')+error.message);
      output.replaceChildren(alert);
      button.disabled = sessionRequired(error)||unconfirmedOperation(error)||!permits(ctx, command);
      if(sessionRequired(error)){
        ctx.sessionRecovery?.(output);
        if(command==='layer.revise'&&body?.record){const copied=el('div',{role:'status'});output.append(el('button',{onclick:()=>copyText(JSON.stringify(body.record,null,2),copied,'Unsaved revision copied. Keep it before refreshing this view.')},'Copy unsaved revision'),copied);}
      }
      if(unconfirmedOperation(error))output.append(el('a',{href:ctx.href('review',{ref:''})},'Open operation recovery'));
      alert.focus({preventScroll:true});alert.scrollIntoView({block:'center',behavior:'instant'});ctx.announce?.(error.message);
    }
  });
  return button;
}
function text(label, value='', area=false) {
  const input=el(area?'textarea':'input', { value, rows: area?3:undefined, required:true, maxlength:4096 });
  return { input, field:el('label',{},label,input) };
}
function supplied(label, value, note) {
  const editor=text(label, JSON.stringify(value,null,2), true);editor.input.rows=12;editor.input.maxLength=800000;
  return { ...editor, field:el('details',{},el('summary',{},label+' — advanced input'),el('p',{class:'muted'},note),editor.field), read:()=>JSON.parse(editor.input.value) };
}
export async function changesView(ctx) {
  const output=el('div',{class:'command-result'}), page=el('div',{class:'page workflow-page'},heading('Changes','Owned drafts and published proposals against an immutable baseline.',ctx));
  if(!ctx.workflow) return page.appendChild(empty('This connection has no authoring service. You can inspect Layers and prepare an explicit CLI handoff from the application map.')) && page;
  if(!ctx.releases.length) {
    const id=text('Initial baseline ID','R-start'), root=text('Root Block ID','app'), purpose=text('Root purpose','',true), selector=text('Responsible scope principal'), releaser=text('Release authority principal');
    const model=ctx.workflow.model_version;
    const build=()=>{
      const key=root.input.value.trim(), b={id:key,parent:null,purpose:purpose.input.value.trim(),requirements:{},acceptance:{},relationships:{},contract:{inputs:{},outputs:{},failures:{}}};
      if(model!=='strata/0.1-facets-experimental'){b.description={format:'plain-text/1',text:''};b.asset_refs={};}
      return {record:{id:id.input.value.trim(),revision:1,model_version:model,root:key,blocks:{[key]:b},authorities:{scopes:[{block:key,selectors:[selector.input.value.trim()]}],release:[releaser.input.value.trim()],guardians:[]},deleted_ids:[]}};
    };
    page.append(el('section',{class:'card'},el('h2',{},'Create the initial baseline'),el('p',{},'Describe the actual intent and assign initial authority explicitly. This records an unvalidated bootstrap baseline. A supported profile, measured evidence and separate approvals are still required for a Release.'),el('div',{class:'form-grid'},id.field,root.field),purpose.field,el('div',{class:'form-grid'},selector.field,releaser.field),action(ctx,'init','Create baseline',build,output)),output);
    return page;
  }
  const baseline=ctx.state.at||ctx.releases[0].ref;
  const release=await ctx.api('record',{ref:baseline,type:'release'});
  page.append(el('p',{class:'context'},'Baseline ',el('code',{},baseline),' · Principal ',el('code',{},ctx.workflow.principal_id)),el('div',{class:'toolbar'},el('button',{class:'primary-button',disabled:!permits(ctx,'layer.create'),onclick:()=>openProposal(ctx,release,ctx.state.block)},'New change')));
  if(ctx.workflow.block_create) page.append(newBlock(ctx,release,output));
  const inbox=await ctx.workRead('review/inbox',{baseline,limit:'100'});
  for(const row of inbox.items.filter(r=>r.type==='layer')) page.append(el('article',{class:'card'},el('div',{class:'card-head'},el('h2',{},el('a',{href:ctx.href('review',{ref:row.ref})},row.intent)),pill(row.published?'Published proposal':'Private draft','proposal')),el('p',{class:'muted'},row.ref+' · '+row.owner),el('p',{},row.review.gates.filter(g=>['blocked','missing','stale'].includes(g.state)).map(g=>g.reason).join(' ')),el('a',{href:ctx.href('review',{ref:row.ref})},'Inspect proposal and actions')));
  if(!inbox.items.some(r=>r.type==='layer'))page.append(empty('No owned drafts or published proposals are visible to this Studio author on this baseline.'));
  page.append(el('p',{class:'muted'},'This inbox uses your current Studio author. Imported drafts keep their recorded author; inspect those retained proposals in ',el('a',{href:ctx.href('layers',{ref:''})},'Layers'),'.'));
  page.append(composeForm(ctx,release,inbox.items.filter(r=>r.type==='layer'&&r.published),output),output);
  return page;
}
function newBlock(ctx, release, output) {
  const id=text('New Block ID'), parent=el('select',{'aria-label':'Creation parent'},Object.values(release.blocks).map(b=>el('option',{value:b.id},b.id))), purpose=text('New Block purpose','',true), intent=text('Why add this Block?','',true), layer=text('New Layer ID');
  const acceptance=supplied('New Block criteria',{},'Add explicit criteria only for real registered review or mechanical checks. No criteria or interfaces are inferred.');
  return el('details',{},el('summary',{},'Add a Block through an owned Layer'),el('div',{class:'card'},el('p',{},'Creation requires an explicit grant on the selected existing parent. New invariant declarations need a future guardian assignment contract and are refused.'),el('div',{class:'form-grid'},layer.field,id.field),el('label',{},'Existing parent',parent),purpose.field,intent.field,acceptance.field,action(ctx,'layer.create','Save new Block proposal',()=>({record:{id:layer.input.value.trim(),revision:1,owner:ctx.workflow.principal_id,model_version:release.model_version,baseline:release.ref,intent:intent.input.value.trim(),created_blocks:[{id:id.input.value.trim(),parent:parent.value,purpose:purpose.input.value.trim(),description:{format:'plain-text/1',text:''},asset_refs:{},requirements:{},acceptance:acceptance.read(),relationships:{},contract:{inputs:{},outputs:{},failures:{}}}],changes:[],acceptance:[],requires_layers:[],read_set:[],assumptions:[],resolution_proposals:[],derived_from:null}}),output)));
}
function composeForm(ctx, release, layers, output) {
  const id=text('Composition ID'), checks=supplied('Compatibility scenario',{id:'intent-review',checks:ctx.workflow.scenarios?.length?[ctx.workflow.scenarios[0]]:[{id:'intent-structure',version:'1'}]},'Choose the exact scenario supported by your project. Generic structure does not imply a realization profile.'), choices=layers.map(l=>({l,input:el('input',{type:'checkbox',checked:true})}));
  return el('section',{class:'card'},el('h2',{},'Compose published Layers'),el('p',{},'Every checked Layer becomes both considered and selected. An unresolved conflict is saved with its exact blocked Composition reference. Omitting a considered Layer requires a sealed Resolution.'),id.field,el('fieldset',{},el('legend',{},'Whole Layers'),choices.map(({l,input})=>el('label',{class:'check-label'},input,l.ref+' — '+l.intent))),checks.field,action(ctx,'compose','Compose selection',()=>{const refs=choices.filter(c=>c.input.checked).map(c=>c.l.ref);return {record:{id:id.input.value.trim(),revision:1,model_version:release.model_version,baseline:release.ref,proposals:refs,selected:refs,alternative_groups:[],scenario:checks.read(),resolutions:[]}};},output));
}
export async function reviewView(ctx) {
  const page=el('div',{class:'page workflow-page'},heading('Review','Proposal publication, candidate decisions, evidence and Release authority are separate gates.',ctx));
  if(!ctx.workflow)return page.appendChild(empty('Current workflow checks are unavailable on this read-only connection. Inspect retained records from Layers, Compositions and Evidence.')) && page;
  if(['strata/0.2-content-mediation-experimental','strata/0.3-block-lifecycle-experimental'].includes(ctx.workflow.model_version)) page.append(el('section',{class:'card'},el('h2',{},'Review an author’s handoff'),el('p',{},'An author can explicitly share exact private draft content. This session cannot browse another owner’s private drafts.'),el('button',{disabled:!permits(ctx,'content.review'),onclick:()=>openSuppliedReview(ctx)},'Review supplied draft'),!permits(ctx,'content.review')?el('p',{class:'muted'},'A configured content.review grant is required.'):null));
  const pending=ctx.pendingOperation?.();
  if(pending){
    if(pending.connection_id!==ctx.connection?.connection_id)page.append(el('section',{class:'card'},el('h2',{},'Reconcile an interrupted operation'),el('p',{},pending.command+' / '+pending.key),el('p',{},'This request belongs to repository ',el('code',{},pending.connection_id),'. Open that original repository through the chooser before inspecting its receipt. The request has not been replayed.')));
    else page.append(operationRecovery(ctx,pending));
  }
  if(pending?.command.startsWith('profile.')&&!ctx.state.ref){
    // Receipt recovery needs no proposal inbox capability. The Local Profiles
    // adapter exposes original-key inspection even when that inbox is absent.
    page.append(el('p',{class:'notice'},'Inspect the original profile save above before another operation.'),el('a',{href:ctx.href('profiles')},'Return to Profiles'));
    return page;
  }
  if(!ctx.state.ref){
    const inbox=await ctx.workRead('review/inbox',{limit:'100'});
    for(const row of inbox.items)page.append(el('article',{class:'card'},el('h2',{},el('a',{href:ctx.href('review',{ref:row.ref})},row.intent||row.ref)),el('p',{class:'muted'},row.ref+' · '+row.type+' · '+(row.owner||'Published record')),el('p',{},row.review.gates.filter(g=>['missing','blocked','stale','unsupported','unavailable'].includes(g.state)).map(g=>g.reason).join(' '))));
    if(inbox.next_cursor)page.append(el('p',{},'More records are available through the paginated CLI review inbox.'));
    return page;
  }
  const review=await ctx.workRead('review/state',{ref:ctx.state.ref}), record=await ctx.api('record',{ref:review.ref,type:review.type}), output=el('div',{class:'command-result'});
  page.append(el('p',{class:'breadcrumb'},el('a',{href:ctx.href('review',{ref:''})},'Review inbox'),' / ',review.ref),el('h2',{},record.intent||review.ref),fields([['Baseline',review.baseline],['Record digest',review.record_sha256],['Candidate',review.candidate||'No accepted candidate'],['Policy',review.policy_generation||'Unavailable']]));
  if(review.type==='layer'){
    page.append(el('section',{},el('h2',{},'Proposed intent'),el('p',{class:'notice'},'This is proposed content. The accepted baseline is unchanged.'),(record.proposals??[]).map(p=>proposalCard(ctx,p,record.baseline)),(record.created_blocks??[]).map(b=>el('article',{class:'card'},pill('New Block proposal','proposal'),el('h3',{},b.id),el('p',{class:'intent-statement'},b.purpose),raw(b)))));
    if(record.derived_from)page.append(el('section',{class:'card'},el('h2',{},'Source, traces and unresolved questions'),el('ul',{},record.derived_from.questions.map(q=>el('li',{},q))),raw(record.derived_from)));
    const normalized=normalizedDraft(record);
    if(record.model_version==='strata/0.3-block-lifecycle-experimental'&&!record.published&&record.owner===ctx.workflow.principal_id&&record.created_blocks?.length) page.append(el('section',{class:'card'},el('h2',{},'New Block requirements'),el('p',{},'Edit one requirement through supported typed fields, preserving this Layer’s other content. Saving creates a new immutable owned revision; existing authoring reviews do not accept its changed content.'),el('button',{disabled:!permits(ctx,'layer.revise'),onclick:()=>openBlockRequirements(ctx,record.ref,normalized)},'Edit new Block requirements'),!permits(ctx,'layer.revise')?el('p',{class:'muted'},'A configured layer.revise grant is required.'):null));
    if(!record.published && record.owner===ctx.workflow.principal_id && ['strata/0.2-content-mediation-experimental','strata/0.3-block-lifecycle-experimental'].includes(record.model_version)) page.append(el('section',{class:'card'},el('h2',{},'Exact reviewer handoff'),el('p',{},'Share this normalized private draft with a reviewer explicitly. Copying does not publish it or grant access to your other drafts.'),el('button',{onclick:()=>openAuthoringHandoff(ctx,normalized,review.record_sha256)},'Prepare reviewer handoff')));
    const revision=supplied('Owned next revision',{...normalized,revision:record.revision+1},'Update complete Layer content. Source questions require a deliberate owned revision. Publishing an existing source never clears questions automatically.');
    const rationale=text('Authoring review rationale','',true), authoring=text('Exact authoring review reference'), source=supplied('Source publication review',record.derived_from?{source_digest:record.derived_from.source_digest,draft_digest:review.record_sha256,reviewer:ctx.workflow.principal_id,accepted:true}:null,'Supply the exact review required by this source contract; no evidence is generated here.');
    const contentModel=record.model_version!=='strata/0.1-facets-experimental';
    page.append(el('section',{class:'card'},el('h2',{},'Owned actions'),el('p',{},'Edit complete Layer content under Owned next revision. Saving creates a new immutable revision. Publication shares a proposal; selection, validation and Release approval remain separate.'),!contentModel?el('p',{class:'muted'},'This legacy project does not require a content authoring attestation. Source-derived proposals still require their exact source publication review.'):null,revision.field,action(ctx,'layer.revise','Save next revision',()=>({previous:record.ref,record:revision.read()}),output),contentModel?rationale.field:null,contentModel?action(ctx,'content.review','Record exact authoring review',()=>({record:{draft:normalized,expected_digest:review.record_sha256,accepted:true,rationale:rationale.input.value}}),output):null,contentModel?authoring.field:null,record.derived_from?source.field:null,action(ctx,'layer.publish','Publish proposal',()=>({ref:record.ref,...(contentModel&&authoring.input.value?{authoring_review:authoring.input.value}:{}),...(record.derived_from?{review:source.read()}:{})}),output)));
  } else if(review.type==='composition'){
    const evaluation=await ctx.api('evaluation',{ref:review.ref});page.append(el('p',{class:'notice'},evaluation.state==='blocked'?'Blocked candidate: inspect competing proposals; no effective winner is shown.':'Candidate intent is eligible for evidence inspection. It is separate from the accepted baseline.'),raw(evaluation));
    if(review.candidate_snapshot)page.append(el('section',{},el('h2',{},'Candidate intent'),el('p',{class:'notice'},'These selected values belong to the candidate. The accepted baseline remains '+review.baseline+'.'),Object.values(review.candidate_snapshot.blocks).map(b=>el('article',{class:'card'},el('h3',{},b.id),el('p',{class:'intent-statement'},b.purpose),b.description?.text?el('p',{},b.description.text):null,el('ul',{},Object.values(b.requirements).map(r=>el('li',{},r.statement)))))));
    page.append(candidateActions(ctx,record,review,output));
  }
  page.append(el('section',{},el('h2',{},'Exact gates'),review.gates.map(g=>el('article',{class:'card gate'},pill(g.state,g.state==='blocked'?'blocked':'neutral'),el('h3',{},g.id.replaceAll('_',' ')),el('p',{},g.reason),g.code&&!['satisfied','not_applicable'].includes(g.state)?el('code',{},g.code):null,g.required_role?el('p',{class:'muted'},'Required authority: '+g.required_role):null,g.operation?el('p',{class:'muted'},'Operation: '+g.operation+' · '+(permits(ctx,g.operation)?'configured and granted':'unavailable to this session')):null))),output,raw(record));
  return page;
}
function operationRecovery(ctx,pending){
  const status=el('div'),check=el('button',{onclick:async()=>{
    check.disabled=true;
    try{ctx.check();const receipt=await ctx.workRead('operation/status',{key:pending.key});ctx.check();
      status.replaceChildren(el('p',{role:'status'},'Original request receipt: '+receipt.state+'.'),raw(receipt));
      if(receipt.state==='committed'){ctx.clearOperation(pending.key);status.append(el('p',{},'The original operation committed. Inspect its saved result; no replay is needed.'));}
      else if(receipt.state==='not_committed'){ctx.clearOperation(pending.key);status.append(el('p',{},'The host confirmed cancellation before effect. Refresh the saved view before starting a new operation.'));}
      else if(receipt.state==='not_found'){
        const acknowledge=el('input',{type:'checkbox'}),dismiss=el('button',{disabled:true,onclick:()=>{ctx.check();if(!acknowledge.checked)return;ctx.clearOperation(pending.key);status.replaceChildren(el('p',{role:'status'},'Browser recovery notice cleared by your choice. No operation was retried and no repository records were deleted.'),el('button',{onclick:()=>ctx.reload()},'Refresh saved view'));}} ,'Clear inspected browser notice');
        acknowledge.addEventListener('change',()=>dismiss.disabled=!acknowledge.checked);
        status.append(el('p',{class:'notice'},'No receipt is visible for this original request. This does not prove that no remote change occurred. Inspect Layers and the project history, or give the original request ID above to the installation operator for reconciliation. Do not blindly repeat the save.'),el('a',{href:ctx.href('layers',{ref:''})},'Inspect saved Layers'),el('label',{},acknowledge,' I have checked the original project history and choose to clear only this browser recovery notice.'),dismiss);
      }else status.append(el('p',{class:'notice'},'The outcome still needs reconciliation. Keep this original request ID and ask the installation operator to inspect it before another save.'));
    }catch(e){status.textContent=e.message;}finally{check.disabled=false;}
  }},'Check original request receipt');
  return el('section',{class:'card'},el('h2',{},'Reconcile an interrupted operation'),el('p',{},pending.command+' / '+pending.key),el('p',{},'Outcome inspection reads the original receipt and does not retry the operation.'),check,status);
}
function candidateActions(ctx,record,review,output){
  const profile=text('Exact finite profile',ctx.workflow.profiles?.[0]||''),slot=text('Configured output slot',ctx.workflow.output_slots?.[0]||''),realization=text('Exact realization reference'),run=text('Exact measured run reference'),reviewRefs=text('Criterion review references (comma separated)'),rationale=text('Criterion review rationale','',true);
  const criterion=supplied('Exact review criterion',{check:'',version:'',fixture:'',method:'review'},'Use the active review criterion from the exact realization; this is a separate human review of the realized intent.');
  const evidence=supplied('Measured evidence',{},'Assemble retained measured results and explicit authenticated attestations. Validation also rechecks the actual output files.');
  const validation=text('Exact validation reference',review.validation_evidence?.[0]?.ref||''),approvals=text('Approval references (comma separated)');
  const approval=supplied('Exact approval request',ctx.workflow.hosted_identity?{format:'approval/3',project_id:ctx.connection.project_id,model_version:record.model_version,baseline:record.baseline,authority_sha256:review.authority_sha256,kind:'scope',target:review.candidate,scope:review.responsible_scope,evidence_digest:review.validation_evidence?.[0]?.evidence_digest||null,generation:ctx.workflow.mediation_generation,expires_at:null,binding:null}:{kind:'scope',target:review.candidate,scope:review.responsible_scope,evidence_digest:review.validation_evidence?.[0]?.evidence_digest||null},'Choose scope, guardian or separate Release approval. Identity is supplied by the host; no authority is inferred from this form.');
  const resolution=supplied('Sealed Resolution request',{layer:'',proposal_index:0,composition:record.ref,approvals:[]},'Use the published decision-only Layer and actual selector approvals.');
  const parts=refs=>refs.split(',').map(s=>s.trim()).filter(Boolean);
  const assemble=el('button',{disabled:!permits(ctx,'evidence.assemble'),onclick:async()=>{assemble.disabled=true;try{const result=await ctx.command('evidence.assemble',{realization:realization.input.value,run_ref:run.input.value,review_refs:parts(reviewRefs.input.value)});evidence.input.value=JSON.stringify(result.data.evidence,null,2);output.replaceChildren(el('p',{role:'status'},'Exact retained evidence assembled. No validation or approval was created.'),raw(result.data));}catch(e){output.textContent=e.message;}finally{assemble.disabled=!permits(ctx,'evidence.assemble');}}},'Assemble retained evidence');
  const preparation=supplied('Decision preparation',{target:record.ref,case_id:'',case_revision:1,expires_at:new Date(Date.now()+3600000).toISOString(),goal:'',partitions:[{id:'option-one',selected:record.proposals,rejected:[]}],supersedes:null},'Supply up to three complete whole-Layer partitions. Preparation returns eligible options or exact diagnostics, and grants no approval.');
  const decision=supplied('Owned decision Layer',{id:'',revision:1,owner:ctx.workflow.principal_id,model_version:record.model_version,baseline:record.baseline,intent:'',...(record.model_version==='strata/0.3-block-lifecycle-experimental'?{created_blocks:[]}:{}),changes:[],acceptance:[],requires_layers:[],read_set:[],assumptions:[],resolution_proposals:[],derived_from:null},'Copy only an exact selection payload returned by the prepared basis. Publish the decision-only Layer before packet preparation.');
  const packet=supplied('Decision packet binding',{basis_ref:'',decisions:[{option_id:'option-one',layer:'',proposal_index:0}]},'Bind each prepared option to a published owned decision Layer.');
  const response=supplied('Prepared decision response',{packet_ref:'',packet_sha256:'',case_revision:1,action:'defer',option_id:null,message:''},'Inspect the exact packet first. Defer and planning direction do not approve. approve_selection needs a baseline selector and an eligible option.');
  const next=supplied('Next candidate composition',{id:record.id,revision:record.revision+1,model_version:record.model_version,baseline:record.baseline,proposals:record.proposals,selected:record.selected,alternative_groups:record.alternative_groups,scenario:record.scenario,resolutions:record.resolutions},'After sealing, list the exact selected partition and Resolution refs in a new immutable Composition revision.');
  return el('section',{class:'card'},el('h2',{},'Candidate actions'),el('div',{class:'form-grid'},profile.field,slot.field),action(ctx,'materialize','Materialize exact candidate',()=>({target:record.ref,profile:profile.input.value,slot:slot.input.value}),output),
    ctx.workflow.hosted_identity?el('details',{},el('summary',{},'Measure and review the exact realization'),action(ctx,'evidence.run','Run configured finite checks',()=>({target:record.ref,profile:profile.input.value,slot:slot.input.value}),output),realization.field,criterion.field,rationale.field,action(ctx,'criterion.review','Attest exact review criterion',()=>({realization:realization.input.value,criterion:criterion.read(),accepted:true,rationale:rationale.input.value}),output),run.field,reviewRefs.field,assemble):null,
    evidence.field,action(ctx,'validate','Validate exact evidence',()=>({target:record.ref,slot:slot.input.value,evidence:evidence.read()}),output),
    el('details',{},el('summary',{},'Resolve competing whole Layers'),preparation.field,action(ctx,'mediation.prepare','Prepare decision basis',()=>preparation.read(),output),decision.field,action(ctx,'layer.create','Save decision Layer',()=>({record:decision.read()}),output),packet.field,action(ctx,'mediation.prepare','Prepare bound decision packet',()=>packet.read(),output),response.field,action(ctx,'mediation.respond','Respond to exact packet',()=>response.read(),output),resolution.field,action(ctx,'resolve','Seal approved decision',()=>({record:resolution.read()}),output),next.field,action(ctx,'compose','Compose resolved candidate',()=>({record:next.read()}),output)),
    approval.field,action(ctx,'approve','Record authorized approval',()=>({record:approval.read()}),output),validation.field,approvals.field,action(ctx,'release','Record approved Release',()=>({target:record.ref,validation:validation.input.value,approvals:parts(approvals.input.value)}),output));
}

function openAuthoringHandoff(ctx, draft, digest) {
  const dialog=modal(ctx,'Exact reviewer handoff');if(!dialog)return;
  const output=el('div',{role:'status'}), error=el('p',{role:'alert',class:'form-error'});
  const packet=JSON.stringify(authoringHandoff(ctx.connection.project_id,draft,digest),null,2);
  const content=el('textarea',{readonly:true,rows:10,'aria-label':'Exact authoring handoff JSON',value:packet});
  dialog.append(el('p',{class:'notice'},'This includes the full private draft. Share it only with your intended reviewer. Nothing is sent automatically.'),fields([['Exact draft',`${draft.id}@${draft.revision}`],['Owner',draft.owner],['Baseline',draft.baseline],['Draft digest',digest]]),el('p',{},'The reviewer returns an immutable authoring-review reference. Paste it into “Exact authoring review reference” to publish this same saved revision. Evidence, scope and Release approvals remain separate.'),content,el('button',{onclick:async()=>{try{ctx.check();await inspectAuthoringHandoff(packet,ctx.connection.project_id,ctx.workflow.model_version);ctx.check();if(dialog.isConnected)await copyText(packet,output,'Exact draft handoff copied. Share it explicitly with your reviewer.');}catch(e){error.textContent=e.message;}}},'Copy exact draft handoff'),output,error);
  dialog.showModal();
}
function handoffBlock(block) {
  const entries=(title,items)=>el('section',{},el('h5',{},title),Object.keys(items??{}).length?Object.entries(items).map(([key,value])=>el('div',{},el('strong',{},key),readableValue(value))):empty('None declared.'));
  return el('article',{class:'card'},pill('New Block proposal','proposal'),el('h4',{},block.id),el('p',{class:'intent-statement'},block.purpose),block.description?.text?el('p',{},block.description.text):null,fields([['Parent Block',block.parent]]),entries('Requirements',block.requirements),entries('Relationships',block.relationships),el('section',{},el('h5',{},'Contract'),entries('Inputs',block.contract?.inputs),entries('Outputs',block.contract?.outputs),entries('Failures',block.contract?.failures)),entries('Acceptance criteria',block.acceptance),Object.keys(block.asset_refs??{}).length?entries('Asset references',block.asset_refs):null);
}
function openBlockRequirements(ctx, previous, draft) {
  const dialog=modal(ctx,'Edit new Block requirements');if(!dialog)return;
  let pending;try{pending=JSON.parse(sessionStorage.getItem('strata-studio-pending')||'null');}catch{}
  if(pending?.command==='layer.revise'&&pending.connection_id===ctx.connection.connection_id){dialog.append(el('p',{class:'notice'},'An earlier revision has an unresolved outcome. Inspect its original request receipt before saving another revision.'),el('button',{onclick:()=>{dialog.close();ctx.reload();}},'Return to receipt recovery'));dialog.showModal();return;}
  let inspected=null,epoch=0,preparing=false,saving=false,finished=false,readRequirement;
  const cancel=dialog.querySelector('.dialog-head button'),error=el('p',{role:'alert',class:'form-error'}),message=el('div',{role:'status'}),preview=el('section',{'aria-label':'Normalized requirement preview'}),editor=el('div');
  const block=el('select',{'aria-label':'Draft Block'},draft.created_blocks.map(b=>el('option',{value:b.id},b.id)));
  const requirement=el('select',{'aria-label':'Draft requirement'});
  const save=el('button',{type:'button',disabled:true,onclick:saveRevision},'Save requirement revision');
  const review=el('button',{type:'submit',disabled:!permits(ctx,'layer.preview')},'Review requirement revision');
  const invalidate=()=>{epoch++;inspected=null;preview.replaceChildren();message.replaceChildren();error.textContent='';save.disabled=true;};
  function renderRequirement(){
    invalidate();const b=draft.created_blocks.find(b=>b.id===block.value),add=requirement.value==='new',keyValue=add?'':requirement.value.slice(12),existing=add?null:b.requirements[keyValue];
    const key=el('input',{'aria-label':'Requirement key',value:keyValue,readonly:!add,maxlength:128});
    const statement=el('textarea',{'aria-label':'Draft requirement statement',value:existing?.statement??'',rows:3,maxlength:4096});
    const kind=el('select',{'aria-label':'Draft requirement kind'},el('option',{value:'rule'},'Rule'),el('option',{value:'invariant',disabled:true},'Invariant — guardian assignment unavailable'));
    const facets=['behavior','design','data','safety'].map(name=>({name,input:el('input',{type:'checkbox',checked:existing?.facets.includes(name)??false,'aria-label':'Draft facet '+name})}));
    const criteria=Object.entries(b.acceptance).map(([name,value])=>({name,input:el('input',{type:'checkbox',checked:existing?.acceptance.includes(name)??false,'aria-label':'Draft criterion '+name}),value}));
    const rows=[],parameters=el('div');
    function parameter(name='',value=''){
      if(rows.length>=32){error.textContent='This form supports up to 32 parameters. Advanced JSON remains available for larger existing records.';return;}
      const nameInput=el('input',{'aria-label':'Parameter name',value:name,maxlength:128}),type=el('select',{'aria-label':'Parameter type'},el('option',{value:'number'},'Number'),el('option',{value:'boolean',selected:typeof value==='boolean'},'Boolean'));
      const number=el('input',{type:'number',step:'any',value:typeof value==='number'?String(value):'', 'aria-label':'Parameter number'}),boolean=el('input',{type:'checkbox',checked:typeof value==='boolean'?value:false,'aria-label':'Parameter boolean'});
      const numberField=el('div',{},el('label',{},'Finite numeric value',number)),booleanField=el('div',{},el('label',{class:'check-label'},boolean,'Boolean value (checked means true)'));
      const row={name:nameInput,type,number,boolean,node:null,losslessName:nameInput.value===name};
      const renderValue=()=>{numberField.hidden=type.value!=='number';booleanField.hidden=type.value!=='boolean';};type.addEventListener('change',renderValue);renderValue();
      row.node=el('fieldset',{},el('legend',{},'Parameter'),el('div',{class:'form-grid'},el('label',{},'Parameter name',nameInput),el('label',{},'Parameter type',type)),numberField,booleanField,el('button',{type:'button',onclick:()=>{rows.splice(rows.indexOf(row),1);row.node.remove();invalidate();}},'Remove parameter'));
      rows.push(row);parameters.append(row.node);
    }
    for(const [name,value] of Object.entries(existing?.parameters??{}))parameter(name,value);
    const tooMany=Object.keys(existing?.parameters??{}).length>32;
    editor.replaceChildren(el('div',{},el('label',{},'Requirement key',key),el('label',{},'Requirement statement',statement),el('label',{},'Requirement kind',kind),el('p',{class:'muted'},'Invariants on new Blocks require explicit guardian assignment support and are unavailable through the current creation operation.'),el('fieldset',{},el('legend',{},'Facets'),facets.map(({name,input})=>el('label',{class:'check-label'},input,name))),
      el('fieldset',{},el('legend',{},'Existing acceptance criteria'),el('p',{class:'muted'},'A link does not change what a criterion checks. Confirm its declared subjects cover the requirement; criterion definitions and subjects remain unchanged here.'),criteria.length?criteria.map(({name,input,value})=>el('div',{},el('label',{class:'check-label'},input,name),readableValue(value))):empty('No criteria are defined. Add an actual criterion through advanced JSON before using this form.')),
      el('section',{},el('h4',{},'Number and boolean parameters'),el('p',{class:'muted'},'Only these two parameter types are supported by this content model. Parameter names and values do not imply profile support.'),parameters,el('button',{type:'button',disabled:tooMany,onclick:()=>{invalidate();parameter();}},'Add parameter')),
      tooMany?el('p',{class:'notice'},'This requirement exceeds the form’s 32-parameter bound. Its values are not discarded: use the full advanced JSON editor.'):null));
    if(rows.some(row=>!row.losslessName))editor.append(el('p',{class:'notice'},'A saved parameter name cannot be preserved by this single-line control. Use advanced JSON to retain its exact content.'));
    readRequirement=()=>{
      if(tooMany)throw new Error('Use advanced JSON to preserve all parameters on this larger requirement.');
      if(rows.some(row=>!row.losslessName))throw new Error('Use advanced JSON: a saved parameter name cannot be preserved by this single-line control.');
      return {add,key:key.value,statement:statement.value,kind:kind.value,facets:facets.filter(f=>f.input.checked).map(f=>f.name),acceptance:criteria.filter(c=>c.input.checked).map(c=>c.name),parameters:rows.map(row=>({name:row.name.value,type:row.type.value,value:row.type.value==='number'?row.number.value:row.boolean.checked}))};
    };
  }
  function renderItems(){const b=draft.created_blocks.find(b=>b.id===block.value);requirement.replaceChildren(...Object.keys(b.requirements).map(key=>el('option',{value:'requirement:'+key},key)),el('option',{value:'new'},'Add a requirement'));renderRequirement();}
  block.addEventListener('change',renderItems);requirement.addEventListener('change',renderRequirement);
  editor.addEventListener('input',invalidate);editor.addEventListener('change',invalidate);
  const form=el('form',{onsubmit:async event=>{
    event.preventDefault();if(preparing||saving||finished)return;
    invalidate();const current=epoch;preparing=true;review.disabled=true;
    try {
      ctx.check();const input=readRequirement(),next=typedBlockRequirement(draft,block.value,input),result=await ctx.workRead('preview',{record:next});ctx.check();
      if(!dialog.isConnected||current!==epoch)return;
      const b=draft.created_blocks.find(b=>b.id===block.value),before=b.requirements[input.key.trim()],proposed=result.record.created_blocks.find(b=>b.id===block.value).requirements[input.key.trim()];
      inspected=result.record;preview.replaceChildren(el('h3',{},'Exact normalized requirement revision'),fields([['Previous saved Layer',previous],['Proposed revision',`${result.record.id}@${result.record.revision}`],['Normalized digest',result.record_sha256]]),el('article',{class:'card'},el('h4',{},block.value+' / requirements.'+input.key.trim()),el('div',{class:'values'},el('div',{},el('h5',{},'Saved draft requirement'),before?readableValue(before):empty('Not present in the saved draft.')),el('div',{},el('h5',{},'Proposed next revision'),readableValue(proposed)))),raw(result.record));
      message.textContent='Model preview completed. Profile support and measured evidence remain separate. Saving rechecks the current owner, head, generation and policy.';save.disabled=!permits(ctx,'layer.revise');
    }catch(e){if(dialog.isConnected&&current===epoch){error.textContent=(e.code?e.code+': ':'')+e.message;inspected=null;}}
    finally{preparing=false;if(dialog.isConnected&&!finished)review.disabled=!permits(ctx,'layer.preview');}
  }},el('p',{},'Edit a requirement on a Block proposed by ',el('code',{},previous),'. Saving creates a new immutable Layer revision; its prior content reviews do not accept changed content.'),el('p',{class:'notice'},'This edits model-supported intent. Finite profiles can require exact names and meaning and may reject an otherwise valid edit. No checks are implemented or executed here. Contracts and criterion definitions remain available through advanced JSON.'),el('div',{class:'form-grid'},el('label',{},'Draft Block',block),el('label',{},'Draft requirement',requirement)),editor,error,review,preview,save,message);
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  async function saveRevision(){
    if(saving||finished||!inspected)return;saving=true;save.disabled=review.disabled=cancel.disabled=true;form.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=true);error.textContent='';message.textContent='Saving the exact normalized next revision…';let dispatched=false;
    try{ctx.check();dispatched=true;const result=await ctx.command('layer.revise',{previous,record:inspected});if(!dialog.isConnected)return;finished=true;message.replaceChildren(el('p',{},'Saved '+result.data.ref+'. Obtain a new exact authoring review before publishing changed content.'),el('a',{href:ctx.href('review',{ref:result.data.ref})},'Inspect saved requirement revision'),raw(result.data));}
    catch(e){if(!dialog.isConnected)return;error.textContent=(e.code?e.code+': ':'')+e.message;inspected=null;finished=dispatched&&(e.code==='OPERATION_UNKNOWN'||e.status>=500||!e.code);message.textContent=finished?'Close and inspect the original request receipt in this connection. Do not save another revision until its outcome is known.':'Refresh and reopen the exact current saved revision before editing again.';}
    finally{saving=false;cancel.disabled=false;cancel.textContent='Close';if(!finished){form.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=false);review.disabled=!permits(ctx,'layer.preview');save.disabled=true;}}
  }
  renderItems();dialog.append(form);dialog.showModal();block.focus();
}
function openSuppliedReview(ctx) {
  const dialog=modal(ctx,'Review supplied draft');if(!dialog)return;
  let recovery;try{recovery=JSON.parse(sessionStorage.getItem('strata-studio-pending')||'null');}catch{}
  if(recovery?.command==='content.review'&&recovery.connection_id===ctx.connection.connection_id){
    dialog.append(el('p',{class:'notice'},'An earlier authoring review has an unresolved outcome in this connection. Check its original request receipt before submitting another decision.'),el('p',{},'Original request: ',el('code',{},recovery.key)),el('button',{onclick:()=>{dialog.close();ctx.reload();}},'Return to receipt recovery'));dialog.showModal();return;
  }
  let inspected=null,pending=false,finished=false,inspection=0;
  const source=el('textarea',{rows:8,maxlength:800000,'aria-label':'Authoring handoff JSON'});
  const suppliedContent=el('details',{open:true},el('summary',{},'Authoring handoff JSON'),el('label',{},'Authoring handoff JSON',source));
  const rationale=el('textarea',{rows:3,maxlength:4096,'aria-label':'Supplied draft review rationale'});
  const preview=el('section',{'aria-label':'Inspected supplied content'}),error=el('p',{role:'alert',class:'form-error'}),output=el('div',{role:'status'});
  const cancel=dialog.querySelector('.dialog-head button');
  const accept=el('button',{type:'button',disabled:true,onclick:()=>submit(true)},'Record accepted review');
  const reject=el('button',{type:'button',disabled:true,onclick:()=>submit(false)},'Record rejected review');
  const sync=()=>{accept.disabled=reject.disabled=pending||finished||!inspected||!rationale.value.trim()||!permits(ctx,'content.review');};
  const invalidate=()=>{inspection++;inspected=null;preview.replaceChildren();error.textContent='';output.textContent='';sync();};
  source.addEventListener('input',invalidate);rationale.addEventListener('input',sync);
  const inspect=el('button',{type:'button',onclick:async()=>{
    const current=++inspection;inspected=null;sync();inspect.disabled=true;error.textContent='';output.textContent='';
    try {
      ctx.check();const packet=await inspectAuthoringHandoff(source.value,ctx.connection.project_id,ctx.workflow.model_version);ctx.check();
      if(!dialog.isConnected||current!==inspection)return;
      const draft=packet.draft;
      preview.replaceChildren(el('div',{},el('h3',{},draft.intent),fields([['Project',packet.project_id],['Exact supplied draft',packet.draft_ref],['Owner',draft.owner],['Baseline',draft.baseline],['Draft digest',packet.draft_digest]]),
        el('p',{class:'notice'},'Digest matches the supplied JSON. This does not prove that it is the author’s current saved head. Publication rechecks the saved revision, digest and active review authority.'),
        (draft.created_blocks??[]).map(handoffBlock),
        draft.changes.map(change=>el('article',{class:'card'},el('h4',{},change.block+' / '+change.path),el('p',{class:'muted'},'Exact supplied proposal'),readableValue(change.value),raw({op:change.op,expected:change.expected}))),
        draft.acceptance.length?el('section',{},el('h4',{},'Proposed acceptance'),readableValue(draft.acceptance)):null,
        draft.derived_from?el('section',{},el('h4',{},'Source, traces and unresolved questions'),readableValue(draft.derived_from)):null,
        raw(draft)));
      suppliedContent.open=false;inspected=packet;output.textContent='Exact supplied content inspected. Choose a decision and give your rationale.';sync();
    } catch(e) {if(dialog.isConnected&&current===inspection){preview.replaceChildren();error.textContent=e.message;}}
    finally {if(dialog.isConnected&&!pending&&!finished)inspect.disabled=false;}
  }},'Inspect exact supplied draft');
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  async function submit(accepted) {
    if(pending||finished||!inspected||!rationale.value.trim())return;
    const packet=inspected;pending=true;sync();source.disabled=rationale.disabled=inspect.disabled=cancel.disabled=true;error.textContent='';output.textContent='Recording the exact authoring review…';dialog.setAttribute('aria-busy','true');
    let dispatched=false;
    try {
      ctx.check();dispatched=true;const result=await ctx.command('content.review',{record:{draft:packet.draft,expected_digest:packet.draft_digest,accepted,rationale:rationale.value.trim()}});
      if(!dialog.isConnected)return;
      finished=true;output.replaceChildren(el('p',{},accepted?'Accepted authoring review recorded.':'Rejected authoring review recorded.'),fields([['Review reference',result.data.ref],['Reviewed draft',result.data.review.draft_ref],['Reviewed digest',result.data.review.draft_digest]]),el('p',{},'Return this exact reference to the author. No publication, validation, scope or Release approval was created.'),el('button',{onclick:()=>copyText(result.data.ref,output,'Exact authoring-review reference copied.')},'Copy authoring-review reference'),raw(result.data));
    } catch(e) {
      if(!dialog.isConnected)return;
      error.textContent=(e.code?e.code+': ':'')+e.message;
      inspected=null;
      if(dispatched&&(e.code==='OPERATION_UNKNOWN'||e.status>=500||!e.code)){finished=true;output.textContent='Close this form and use “Check original request receipt” in this connection’s Review inbox. Do not submit again until the original outcome is known.';}
      else {preview.replaceChildren();output.textContent='Refresh the saved view and inspect the exact handoff again before another decision.';}
    } finally {
      pending=false;dialog.removeAttribute('aria-busy');cancel.disabled=false;cancel.textContent='Close';source.disabled=rationale.disabled=inspect.disabled=finished;sync();
    }
  }
  dialog.append(el('p',{},'Paste the author’s exact handoff. Inspection stays in this browser; recording a decision uses your existing content.review grant. The host supplies your reviewer identity.'),suppliedContent,inspect,preview,el('label',{},'Supplied draft review rationale',rationale),el('div',{class:'toolbar'},accept,reject),error,output);
  dialog.showModal();source.focus();
}
