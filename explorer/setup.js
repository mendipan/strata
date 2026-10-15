import {el} from './dom.js';

export async function ownerRequest(route,{method='GET',body,csrf,signal}={}){
  const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(method==='GET'?5000:15000)]);
  const response=await fetch(route,{method,headers:{...(method==='POST'?{'content-type':'application/json','x-studio-csrf':csrf}: {})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',signal:bounded});
  const result=await response.json();if(!response.ok){const error=new Error(result.error?.message??'Studio action failed.');error.code=result.error?.code;error.status=response.status;throw error;}return result;
}
export function secretField(id,label,autocomplete='new-password',max=512){
  const input=el('input',{id,type:'password',autocomplete,maxlength:max,spellcheck:false,required:true}),toggle=el('button',{type:'button','aria-controls':id,'aria-pressed':'false',onclick:()=>{const show=input.type==='password';input.type=show?'text':'password';toggle.textContent=show?'Hide '+label.toLowerCase():'Show '+label.toLowerCase();toggle.setAttribute('aria-pressed',String(show));}},'Show '+label.toLowerCase());
  const node=el('div',{class:'secret-field'},el('label',{for:id},label),el('div',{class:'secret-control'},input,toggle));
  const clear=()=>{input.value='';input.type='password';toggle.textContent='Show '+label.toLowerCase();toggle.setAttribute('aria-pressed','false');};return {node,input,clear,toggle};
}
const acknowledgement='Studio stores your API token encrypted on this host. Its encryption key is also protected on this host. A host administrator or a backup containing both can access the token. Losing the key means entering the token again.';
export async function browserSetup(content){
  let status=await ownerRequest('/studio/setup'),busy=false,timer,finished=false,operationId=crypto.randomUUID();
  const message=el('p',{role:'status','aria-live':'polite'}),username=el('input',{id:'owner-name',autocomplete:'username',required:true,minlength:3,maxlength:32,pattern:'[A-Za-z0-9._-]{3,32}'}),password=secretField('owner-password','Password'),confirm=secretField('owner-confirm','Confirm password'),ack=el('input',{id:'owner-storage-ack',type:'checkbox',required:true});
  const clear=()=>{password.clear();confirm.clear();};window.addEventListener('pagehide',clear);window.addEventListener('hashchange',clear);
  const current=()=>document.visibilityState==='visible';
  function schedule(){clearTimeout(timer);if(!finished&&['pending','approved','finishing'].includes(status.state))timer=setTimeout(async()=>{if(current()&&!busy)await refresh(false);schedule();},3000);}
  async function refresh(force=true){try{const next=await ownerRequest('/studio/setup/outcome');const changed=next.state!==status.state;status=next;if(force||changed)paint();if(status.state==='complete')done();}catch(e){message.textContent=e.message;} }
  let resolve;const completion=new Promise(r=>resolve=r);
  function done(){finished=true;clearTimeout(timer);clear();window.removeEventListener('pagehide',clear);window.removeEventListener('hashchange',clear);resolve();}
  async function action(route,body){if(busy)return;busy=true;message.textContent='Waiting for Studio.';paint(false);try{status=await ownerRequest(route,{method:'POST',csrf:status.csrf,body,signal:AbortSignal.timeout(15000)});await refresh();}catch(e){message.textContent=e.name==='TimeoutError'||!e.status?'The outcome is unknown. Check setup outcome before continuing.':e.message;}finally{busy=false;paint(false);schedule();}}
  function paint(focus=true){
    if(status.operation_id)operationId=status.operation_id;
    if(status.state==='complete'){done();return;}
    const recovering=status.purpose==='recover-owner-password',title=status.state==='available'?(recovering?'Recover your sign-in.':'Set up your Studio.'):status.state==='pending'?'Confirm this browser.':status.state==='approved'?(recovering?'Choose a new password.':'Create your sign-in.'):status.state==='finishing'?'Finishing setup.':'Studio owner verification.';
    const card=el('div',{class:'welcome owner-setup'},el('h1',{tabindex:'-1'},title));
    if(status.state==='available')card.append(el('p',{},'Create your sign-in and save credentials here after confirming this browser in your trusted setup conversation.'),el('button',{disabled:busy,onclick:()=>action('/studio/setup/request',{request_id:crypto.randomUUID(),expected_generation:status.generation})},'Start setup'));
    else if(['pending','approved'].includes(status.state)){
      card.append(el('p',{class:'muted'},status.origin),el('div',{class:'setup-code'},el('span',{},'Public request code'),el('code',{},status.request.code)),el('p',{},'Expires '+new Date(status.request.expires_at).toLocaleTimeString()+'. Purpose: '+status.purpose+'.'));
      if(status.state==='pending')card.append(el('p',{},'Copy this code into your existing trusted setup conversation to confirm this browser. Keep this page open. The code contains no password or access credential.'),el('button',{disabled:busy,onclick:async()=>{try{await navigator.clipboard.writeText(status.request.code);message.textContent='Request code copied.';}catch{message.textContent='Copy unavailable. Select the public code above.';}}},'Copy request code'));
      else{
        const submit=el('button',{type:'submit',disabled:busy},recovering?'Save new password':'Create owner account');
        const form=el('form',{onsubmit:async event=>{event.preventDefault();if(busy)return;const value=password.input.value.normalize('NFC');if([...value].length<15||[...value].length>128){message.textContent='Use 15–128 characters for your password.';password.input.focus();return;}if(value!==confirm.input.value.normalize('NFC')){message.textContent='The passwords do not match.';confirm.input.focus();return;}if(!recovering&&!ack.checked){ack.focus();return;}const input=recovering?{request_id:operationId,expected_generation:status.generation,expected_authentication_generation:status.authentication_generation,new_password:value}:{request_id:operationId,expected_generation:status.generation,username:username.value,password:value,key_storage_policy:'host-bound'};clear();await action(recovering?'/studio/setup/recover':'/studio/setup/complete',input);}},...(!recovering?[el('label',{for:'owner-name'},'Sign-in name'),username,el('p',{class:'muted'},'3–32 letters, digits, dots, underscores or hyphens. Your name is stored in lowercase.')]:[]),password.node,el('p',{class:'muted'},'Use 15–128 characters. Paste and password managers are supported.'),confirm.node,...(!recovering?[el('p',{},acknowledgement),el('label',{class:'check-label',for:'owner-storage-ack'},ack,'I accept this host-bound storage model.')]:[el('p',{},'Password recovery preserves your stored token and its encryption key.')]),submit);
        card.append(form);
      }
      card.append(el('button',{disabled:busy,type:'button',onclick:async()=>{clear();await action('/studio/setup/cancel',{request_id:crypto.randomUUID(),expected_generation:status.generation});}},'Cancel setup'));
    }else if(status.state==='finishing')card.append(el('p',{},'Your sign-in was saved. Studio is waiting for the independent host completion record. Once it is confirmed, sign in with your chosen password.'));
    else card.append(el('p',{},status.message??'Owner verification has not been enabled for this installation. Request verification in your trusted setup conversation.'));
    card.append(message,el('button',{type:'button',disabled:busy,onclick:()=>refresh()},'Check setup outcome'));content.replaceChildren(card);if(focus)card.querySelector('h1').focus();schedule();
  }
  paint();if(status.state==='complete')done();await completion;return true;
}
