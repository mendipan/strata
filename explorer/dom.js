export function el(tag, attrs={}, ...children) {
  const node=['svg','path'].includes(tag)?document.createElementNS('http://www.w3.org/2000/svg',tag):document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)) {
    if(value===undefined || value===null || value===false) continue;
    if(key==='class') node.setAttribute('class',value);
    else if(key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else if(['checked','disabled','selected','value','open'].includes(key)) node[key]=value;
    else node.setAttribute(key,value===true?'':String(value));
  }
  for(const child of children.flat(Infinity)) if(child!==undefined && child!==null && child!==false) node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
export const titleCase=text=>text.charAt(0).toUpperCase()+text.slice(1);
export const pill=(text,kind='neutral')=>el('span',{class:'pill '+kind},text);
export const facets=(names,prefix)=>el('div',{class:'facets'},prefix?el('span',{class:'muted'},prefix):null,names.map(name=>pill(titleCase(name),name)));
export const empty=text=>el('p',{class:'empty'},text);
export function welcomeIntro() {
  return el('div',{class:'welcome-intro'},
    el('p',{},'Strata is source control for application intent: behavior, constraints, and reviewed decisions. The code can change. What you learned should carry forward.'),
    el('p',{class:'muted'},'Start with an exact Release, then choose a Block to inspect what must hold. Studio shows retained records; viewing a candidate does not validate or approve it.'),
    el('details',{},el('summary',{},'Five concepts for your first visit'),el('dl',{class:'welcome-concepts'},[
      ['Block','A bounded behavior with a contract, requirements, relationships, and acceptance criteria.'],
      ['Layer','One actor’s immutable, revisioned proposal against an exact baseline.'],
      ['Composition','An immutable candidate pinning the baseline, considered and selected revisions, scenario, and Resolutions.'],
      ['Resolution','An authorized, revision-bound decision about a specific interaction.'],
      ['Release','An immutable, approved semantic snapshot produced by validated flattening, with provenance and evidence.']
    ].map(([term,definition])=>el('div',{},el('dt',{},term),el('dd',{},definition))))),
    el('p',{},el('a',{href:'https://github.com/mendipan/strata#the-model',target:'_blank',rel:'noopener noreferrer'},'Read the Strata model (new tab)')));
}
export const json=value=>el('pre',{class:'json',tabindex:'0','aria-label':'Structured record value'},JSON.stringify(value,null,2));
export const raw=value=>el('details',{class:'raw'},el('summary',{},'Allowed record fields · JSON'),json(value));
export function section(id,label,...children) {return el('section',{id,class:'section'},el('h2',{tabindex:'-1'},label),...children);}
export const field=(name,value)=>el('div',{class:'field'},el('dt',{},name),el('dd',{},value));
export const fields=rows=>el('dl',{class:'fields'},rows.map(([name,value])=>field(name,value)));
export const refLink=(ctx,ref,type='layer')=>el('a',{class:'mono',href:ctx.href(type==='release'?'blocks':type==='composition'?'compositions':type==='layer'?'layers':'evidence',type==='release'?{at:ref,block:''}:{ref,type})},ref);
export const refList=(ctx,refs,type)=>refs.length?el('ul',{class:'ref-list'},refs.map(ref=>el('li',{},refLink(ctx,ref,type)))):empty('None recorded.');
export function contents(labels) {return el('nav',{class:'contents','aria-label':'Contents'},labels.map(([id,label])=>el('a',{href:'#'+id,onclick:event=>{event.preventDefault();const section=document.getElementById(id);section?.scrollIntoView({block:'start'});section?.querySelector('h2')?.focus({preventScroll:true});}},label)));}
export function heading(name,subtitle,ctx,extra) {
  return el('div',{class:'heading'},el('div',{},el('h1',{tabindex:'-1'},name),subtitle?el('p',{class:'purpose'},subtitle):null),el('div',{class:'heading-actions'},extra,el('button',{class:'text-button',onclick:()=>ctx.copy()},'Copy reference')));
}
export function statusRows(ctx,status) {
  return el('div',{class:'status-rows'},fields([['Candidate evaluation',status.evaluation],['Retained validation',status.matching_validation.length?'Matching retained validation':'No matching retained evidence in this view.'],['Required approval coverage',status.approval_coverage.map(x=>`${x.kind}: ${x.recorded?'recorded':'not recorded'}`).join(' · ')],['Publication',status.publication],['Trust',status.trust],['Authority',status.authority_coverage]]),refList(ctx,status.matching_validation,'validation'),status.mismatched_validation.length?el('div',{class:'notice'},'Does not match this candidate',refList(ctx,status.mismatched_validation,'validation')):null,status.mismatched_approvals.length?el('div',{class:'notice'},'Approval binding does not match',refList(ctx,status.mismatched_approvals,'approval')):null);
}
export function table(headers,rows) {return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},headers.map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows.map(row=>el('tr',{},row.map((cell,i)=>el('td',{'data-label':headers[i]},cell)))))));}
