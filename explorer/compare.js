import { el, json, heading, empty, pill, refLink } from './dom.js';
export async function compareView(ctx) {
  const compositions=await ctx.all('records',{type:'composition'}), options=[...ctx.releases,...compositions.items].sort((a,b)=>a.ref.localeCompare(b.ref));
  const selector=(side)=>el('label',{},side==='left'?'Before · exact reference':'After · exact reference',el('select',{'aria-label':side==='left'?'Before reference':'After reference',value:ctx.state[side],onchange:e=>ctx.navigate('compare',{[side]:e.target.value})},el('option',{value:''},'Choose exact Release / Composition'),options.map(r=>el('option',{value:r.ref,selected:r.ref===ctx.state[side]},r.ref+' · '+r.type))));
  const page=el('div',{class:'page'},heading('Compare','Atomic semantic items between two exact snapshots.',ctx),el('p',{class:'muted'},'Before and After describe comparison orientation. Neither implies chronology.'),el('div',{class:'toolbar'},selector('left'),selector('right'),el('button',{onclick:()=>ctx.navigate('compare',{left:ctx.state.right,right:ctx.state.left})},'Swap sides'),el('label',{},el('input',{type:'checkbox',checked:ctx.state.all==='true',onchange:e=>ctx.navigate('compare',{all:e.target.checked?'true':'false'})}),' All items')));
  if(!ctx.state.left || !ctx.state.right) {page.append(empty('Choose two exact references to compare. Layers have proposal views rather than snapshot comparisons.'));return page;}
  const [left,right]=await Promise.all([ctx.api('record',{ref:ctx.state.left,type:options.find(r=>r.ref===ctx.state.left)?.type ?? 'release'}),ctx.api('record',{ref:ctx.state.right,type:options.find(r=>r.ref===ctx.state.right)?.type ?? 'release'})]);
  page.append(el('div',{class:'values'},...[[left,'Before'],[right,'After']].map(([record,label])=>el('div',{},el('h3',{},label+' · '+record.type),refLink(ctx,record.ref,record.type),el('p',{class:'muted'},record.model_version),record.baseline?el('p',{},'Baseline ',refLink(ctx,record.baseline,'release')):pill('Bootstrap baseline')))));
  try {
    const data=await ctx.all('diff',{left:ctx.state.left,right:ctx.state.right,all:ctx.state.all==='true'?'true':'false'});
    page.append(el('p',{class:'context'},`${data.total} ${ctx.state.all==='true'?'atomic items':'changed items'}`));
    page.append(el('p',{class:'muted'},data.coverage));
    if(!data.items.length) page.append(empty('No changes to Block intent or pinned authority policy between these exact snapshots.'));
    for(const row of data.items) page.append(el('article',{class:'card'},el('div',{class:'card-head'},el('h3',{class:'mono'},row.kind==='authority'?'Authority / '+row.path:row.block+' / '+(row.path ?? 'Block')),pill(row.changed?'Changed':'Unchanged')),el('div',{class:'values'},...[[row.before,'Before'],[row.after,'After']].map(([value,label])=>el('div',{},el('h3',{},label),value.kind==='absent'?empty('Absence · no item is present'):json(value.value))))));
  } catch(error) {if(error.name==='AbortError')throw error;page.append(el('div',{class:'notice error',role:'alert'},el('h2',{},'An effective comparison is unavailable.'),el('p',{},error.message),[left,right].filter(r=>r.type==='composition').map(r=>el('p',{},refLink(ctx,r.ref,'composition'),' · inspect conflicts and coverage'))));}
  return page;
}
