import { el } from './dom.js';
import { workspaceSession } from './workspace-session.js';
import { ownerHostedSession } from './owner-session.js';

// Hosted keys are submitted once over the configured HTTPS origin. Only the
// session-bound CSRF value stays in memory; the cookie is inaccessible to JS.
export async function hostedSession() {
  const content = document.getElementById('content');let response,status;
  try{
  response = await fetch('/studio/session', { cache:'no-store', credentials:'same-origin',signal:AbortSignal.timeout(5000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Studio proxy access is not configured correctly.');
  status = await response.json();
  }catch(error){content.replaceChildren(el('div',{class:'welcome',role:'alert'},el('h1',{},'Studio is unavailable.'),el('p',{},error.name==='TimeoutError'?'Studio sign-in status took too long to load. Try again when the connection returns.':error.message),el('button',{onclick:()=>location.reload()},'Retry Studio')));return new Promise(()=>{});}
  if (!['hosted-read-only','hosted-actor','hosted-owner'].includes(status.mode)) return null;
  document.title = 'Strata Studio';
  document.getElementById('header').replaceChildren(el('div', {class:'brand'}, 'strata', el('small', {}, 'Studio')));
  if(status.mode==='hosted-owner'){const owner=await ownerHostedSession(status,content);return status.workspace?workspaceSession({...owner,namespace:status.namespace===true}):owner;}
  if (!status.configured) {
    content.replaceChildren(el('div', {class:'welcome'}, el('h1', {tabindex:'-1'}, 'Studio setup required.'), el('p', {}, 'This hosted service is read only and has no sign-in configured. The owner must configure protected sign-in and a trusted project connection on the host.'), el('p', {}, 'No project records or provider credentials are available here.')));
    content.querySelector('h1').focus();
    return new Promise(() => {});
  }
  if (!status.authenticated) status = await new Promise(resolve => {
    const account=el('input',{id:'studio-account',autocomplete:'off',required:true,maxlength:128});
    const key = el('input', {id:'studio-access-key',type:'password',autocomplete:'off',required:true,maxlength:43});
    const message = el('p', {role:'status','aria-live':'polite'}), submit = el('button', {type:'submit'}, 'Sign in');
    const form = el('form', {onsubmit:async event => {
      event.preventDefault(); submit.disabled = true; message.textContent = 'Signing in.';
      const accessKey = key.value; key.value = '';
      try {
        const result = await fetch('/studio/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(status.mode==='hosted-actor'?{account_id:account.value,access_key:accessKey}:{access_key:accessKey}),cache:'no-store',credentials:'same-origin'});
        const data = await result.json();
        if (!result.ok) throw new Error(data.error?.message ?? 'Sign-in failed.');
        resolve(data);
      } catch (error) { message.textContent = error.message; submit.disabled = false; key.focus(); }
    }}, ...(status.mode==='hosted-actor'?[el('label',{for:'studio-account'},'Provisioned account'),account]:[]),el('label', {for:'studio-access-key'}, 'Studio access key'), key, submit, message);
    content.replaceChildren(el('div', {class:'welcome'}, el('h1', {tabindex:'-1'}, 'Sign in to Strata Studio.'), el('p', {}, 'Use the Studio access key provisioned by the owner. Available operations depend on the assigned account and project grants.'), form));
    (status.mode==='hosted-actor'?account:key).focus();
  });
  // Capture the authenticated principal for in-place recovery of an existing
  // draft. A different sign-in cannot silently take over its authoring scope.
  if(status.mode==='hosted-actor'&&!status.principal_id)try{const response=await fetch('/studio/session',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(5000)});if(response.ok){const next=await response.json();if(next.authenticated)status=next;}}catch{}
  const principal=status.principal_id;
  return {
    refreshSession:async signal=>{const response=await fetch('/studio/session',{cache:'no-store',credentials:'same-origin',signal});if(!response.ok)return false;const next=await response.json();if(!next.authenticated||next.principal_id!==principal)return false;status=next;return true;},
    headers: method => method === 'POST' ? {'x-studio-csrf':status.csrf} : {},
    logout: async () => {
      const response = await fetch('/studio/logout', {method:'POST',headers:{'content-type':'application/json','x-studio-csrf':status.csrf},body:'{}',cache:'no-store',credentials:'same-origin'});
      if (!response.ok) throw new Error('Studio sign-out failed.');
      location.reload();
    },
  };
}
