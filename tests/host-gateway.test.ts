import {request as httpRequest} from 'node:http';
import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {mkdtemp,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runAuthorStudio} from '../scripts/studio-author.js';import {BLOCK_MODEL,digest} from '../src/model.js';import {runCli} from '../src/cli.js';
test('explicit hosted actor gateway isolates readers, rejects fixture spoofing, supports CLI and survives restart',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'strata-actor-gateway-')),origin='https://studio.example',key=Buffer.alloc(32,19).toString('base64url'),readKey=Buffer.alloc(32,23).toString('base64url');const read=['capabilities','review.inbox','review.state','layer.preview','studio.snapshot','operation.inspect','inspect','status','diff','conflicts'];const accounts={format:'strata-host-accounts/1',generation:1,accounts:[['author-a',key],['reader',readKey]].map(([principal_id,k])=>({account_id:principal_id,principal_id,principal_kind:'person',active:true,credential_epoch:1,key_sha256:createHash('sha256').update(k).digest('hex')}))},policy={format:'strata-host-policy/1',project_id:'synthetic-gateway',generation:1,grants:['author-a','reader'].map(principal_id=>({grant_id:principal_id,principal_id,operations:[...read,...(principal_id==='author-a'?['init','layer.create','layer.revise','layer.publish','content.review']:[])],layer_ids:null,write_block_ids:principal_id==='author-a'?['app']:[],create_under_block_ids:principal_id==='author-a'?['app']:[],approvals:[],profiles:[],expires_at:new Date(Date.now()+3600000).toISOString()}))};const config={format:'strata-studio-author-host/1',project_id:policy.project_id,project_directory:root,state_directory:path.join(root,'state'),accounts_file:path.join(root,'accounts.json'),policy_file:path.join(root,'policy.json'),public_origin:origin,trusted_proxy_addresses:['127.0.0.1'],port:0,operations:['init','layer.create','layer.revise','layer.publish','content.review'],output_slots:{},runner_profiles:[]};for(const [name,value]of [['accounts',accounts],['policy',policy],['host',config]] as const)await writeFile(path.join(root,name+'.json'),JSON.stringify(value),{mode:0o600});let host=await runAuthorStudio(path.join(root,'host.json'),path.resolve('explorer'));
  const fetchOriginal=globalThis.fetch;const proxy=(url:string,init:any):Promise<any>=>new Promise((resolve,reject)=>{const req=httpRequest(url,{method:init.method,headers:init.headers},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers as any})));});req.on('error',reject);req.end(init.body);});const request=(route:string,body?:any,cookie?:string,csrf?:string,extra:any={}):Promise<any>=>proxy(host.origin+route,{method:body===undefined?'GET':'POST',headers:{host:'studio.example','x-forwarded-proto':'https',...(body===undefined?{}:{origin,'content-type':'application/json'}),...(cookie?{cookie}:{}),...(csrf?{'x-studio-csrf':csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  try{const unauth=await request('/studio/v1/capabilities');assert.equal(unauth.status,401,await unauth.text());const denied=await request('/studio/login',{account_id:'fixture-a',access_key:key});assert.equal(denied.status,401,await denied.text());const signed=await request('/studio/login',{account_id:'author-a',access_key:key}),auth=await signed.json(),cookie=signed.headers.get('set-cookie')!.split(';')[0];assert.match(signed.headers.get('set-cookie')!,/HttpOnly; Secure; SameSite=Strict/);const firstRead=(await(await request('/explorer/v1/connection',undefined,cookie)).json()).data;assert.equal(firstRead.ready,true);const cap=(await(await request('/studio/v1/capabilities',undefined,cookie)).json()).data;
    const baseline={id:'R-start',revision:1,model_version:BLOCK_MODEL,root:'app',blocks:{app:{id:'app',parent:null,purpose:'Maintain synthetic inventory.',description:{format:'plain-text/1',text:''},asset_refs:{},requirements:{},acceptance:{},relationships:{},contract:{inputs:{},outputs:{},failures:{}}}},authorities:{scopes:[{block:'app',selectors:['author-a']}],release:['author-a'],guardians:[]},deleted_ids:[]};const envelope=(command:string,input:any,c:any,id=crypto.randomUUID())=>({command,input,idempotency_key:id,expected_generation:c.generation,expected_policy:c.policy_generation});assert.equal((await request('/studio/v1/operation',envelope('init',{record:baseline},cap),cookie)).status,403);assert.equal((await request('/studio/v1/operation',envelope('init',{record:baseline},cap),cookie,auth.csrf,{origin:'https://foreign.example'})).status,403);const initialized=await request('/studio/v1/operation',envelope('init',{record:baseline},cap),cookie,auth.csrf);assert.equal(initialized.status,200,await initialized.text());
    const current=(await(await request('/studio/v1/capabilities',undefined,cookie)).json()).data,layer={id:'L-private',revision:1,model_version:BLOCK_MODEL,owner:'author-a',baseline:'R-start@1',intent:'Change synthetic purpose.',created_blocks:[],changes:[{op:'set_item',block:'app',path:'purpose',expected:{kind:'value',value:baseline.blocks.app.purpose},value:'Maintain checked inventory.'}],acceptance:[],read_set:[],requires_layers:[],assumptions:[],resolution_proposals:[],derived_from:null};const keyId=crypto.randomUUID(),saved=await request('/studio/v1/operation',envelope('layer.create',{record:layer},current,keyId),cookie,auth.csrf);assert.equal(saved.status,200,await saved.text());const stale=await request('/studio/v1/operation',envelope('layer.create',{record:{...layer,id:'L-stale'}},current),cookie,auth.csrf);assert.equal(stale.status,409);const replay=await request('/studio/v1/operation',envelope('layer.create',{record:layer},current,keyId),cookie,auth.csrf);assert.equal((await replay.json()).data.reused,true);
    const reviewCap=(await(await request('/studio/v1/capabilities',undefined,cookie)).json()).data;const reviewResponse=await request('/studio/v1/operation',envelope('content.review',{record:{draft:layer,expected_digest:digest(layer),accepted:true,rationale:'Reviewed a private synthetic draft.'}},reviewCap),cookie,auth.csrf);assert.equal(reviewResponse.status,200,await reviewResponse.clone().text());const privateReview=(await reviewResponse.json()).data.data.ref;const reviewRecord=await request('/studio/v1/operation',envelope('inspect',{type:'authoring-review',ref:privateReview},(await(await request('/studio/v1/capabilities',undefined,cookie)).json()).data),cookie,auth.csrf);const privateAuth=(await reviewRecord.json()).data.data.auth_receipt;
    const rlogin=await request('/studio/login',{account_id:'reader',access_key:readKey}),rCookie=rlogin.headers.get('set-cookie')!.split(';')[0],rAuth=await rlogin.json();const rCap=(await(await request('/studio/v1/capabilities',undefined,rCookie)).json()).data;assert.equal((await request('/studio/v1/operation',envelope('layer.create',{record:layer},rCap),rCookie,rAuth.csrf)).status,403);assert.equal((await request('/studio/v1/operation',envelope('inspect',{type:'layer',ref:'L-private@1'},rCap),rCookie,rAuth.csrf)).status,422);const rRecords=(await(await request('/explorer/v1/connection',undefined,rCookie)).json()).data;assert.equal(JSON.stringify(rRecords).includes('L-private'),false);
    assert.equal((await request('/studio/v1/operation',envelope('inspect',{type:'authoring-review',ref:privateReview},rCap),rCookie,rAuth.csrf)).status,422);assert.equal((await request('/studio/v1/operation',envelope('inspect',{type:'auth-receipt',ref:privateAuth},rCap),rCookie,rAuth.csrf)).status,422);const authList=await request('/studio/v1/operation',envelope('inspect',{type:'auth-receipt'},rCap),rCookie,rAuth.csrf);assert.equal(JSON.stringify(await authList.json()).includes(privateAuth),false);const reviewList=await request('/studio/v1/operation',envelope('inspect',{type:'authoring-review'},rCap),rCookie,rAuth.csrf);assert.equal(reviewList.status,200,await reviewList.clone().text());assert.equal(JSON.stringify(await reviewList.json()).includes(privateReview),false);
    await writeFile(path.join(root,'strata.config.json'),JSON.stringify({schema_version:'1',model_version:BLOCK_MODEL,project_id:policy.project_id,broker:origin,artifact_adapter:'hosted-local-state',identity_policy:'host-accounts/1',network_policy:'configured-https',profiles:[]}));globalThis.fetch=async(input:any,init:any)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(url.origin!==origin)return fetchOriginal(input,init);return proxy(host.origin+url.pathname+url.search,{...init,headers:{...init?.headers,host:'studio.example','x-forwarded-proto':'https'}});};const cli=await runCli(['inspect','layer','L-private@1','--project',root,'--json'],undefined,{STRATA_HOST_ACCOUNT:'author-a',STRATA_HOST_KEY:key});assert.equal(cli.ok,true,JSON.stringify(cli.errors));assert.equal(cli.data.owner,'author-a');assert.equal(JSON.stringify(cli).includes(key),false);globalThis.fetch=fetchOriginal;
    await host.close();host=await runAuthorStudio(path.join(root,'host.json'),path.resolve('explorer'));assert.equal((await request('/studio/v1/capabilities',undefined,cookie)).status,401);const newLogin=await request('/studio/login',{account_id:'author-a',access_key:key}),newCookie=newLogin.headers.get('set-cookie')!.split(';')[0];const inbox=(await(await request('/studio/v1/review/inbox',undefined,newCookie)).json()).data;assert(inbox.items.some((x:any)=>x.ref==='L-private@1'));assert.equal((await request('/studio/v1/capabilities',undefined,newCookie,undefined,{'x-forwarded-for':'1.1.1.1'})).status,403);const ledger=await readFile(path.join(root,'state/audit.jsonl'),'utf8');assert.equal(ledger.includes(key)||ledger.includes(readKey),false);
  }finally{globalThis.fetch=fetchOriginal;await host.close();}
});


test('cached actor reads reauthorize after policy revocation while the account stays active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-actor-read-revocation-'));
  const origin = 'https://studio.example', key = Buffer.alloc(32, 31).toString('base64url');
  const operations = ['capabilities', 'studio.snapshot', 'operation.inspect', 'inspect', 'init', 'layer.create'];
  const accounts = { format: 'strata-host-accounts/1', generation: 1, accounts: [{ account_id: 'author',
    principal_id: 'author', principal_kind: 'person', active: true, credential_epoch: 1,
    key_sha256: createHash('sha256').update(key).digest('hex') }] };
  const policy = { format: 'strata-host-policy/1', project_id: 'synthetic-read-revocation', generation: 1,
    grants: [{ grant_id: 'author', principal_id: 'author', operations: [...operations], layer_ids: null,
      write_block_ids: ['app'], create_under_block_ids: [], approvals: [], profiles: [],
      expires_at: new Date(Date.now() + 3600000).toISOString() }] };
  const config = { format: 'strata-studio-author-host/1', project_id: policy.project_id,
    project_directory: root, state_directory: path.join(root, 'state'), accounts_file: path.join(root, 'accounts.json'),
    policy_file: path.join(root, 'policy.json'), public_origin: origin, trusted_proxy_addresses: ['127.0.0.1'],
    port: 0, operations: ['init', 'layer.create'], output_slots: {}, runner_profiles: [] };
  for (const [name, value] of [['accounts', accounts], ['policy', policy], ['host', config]] as const)
    await writeFile(path.join(root, name + '.json'), JSON.stringify(value), { mode: 0o600 });
  const host = await runAuthorStudio(path.join(root, 'host.json'), path.resolve('explorer'));
  const send = (route: string, body?: any, cookie?: string, csrf?: string): Promise<any> => new Promise((resolve, reject) => {
    const req = httpRequest(host.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      host: 'studio.example', 'x-forwarded-proto': 'https',
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-studio-csrf': csrf } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text, data: JSON.parse(text), headers: res.headers }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const login = await send('/studio/login', { account_id: 'author', access_key: key });
    assert.equal(login.status, 200); const cookie = login.headers['set-cookie'][0].split(';')[0], csrf = login.data.csrf;
    const capabilities = async () => (await send('/studio/v1/capabilities', undefined, cookie)).data.data;
    const dispatch = async (command: string, record: any) => {
      const cap = await capabilities(); return send('/studio/v1/operation', { command, input: { record },
        idempotency_key: crypto.randomUUID(), expected_generation: cap.generation, expected_policy: cap.policy_generation }, cookie, csrf);
    };
    const baseline = { id: 'R-start', revision: 1, model_version: BLOCK_MODEL, root: 'app', blocks: { app: {
      id: 'app', parent: null, purpose: 'Retain synthetic project.', description: { format: 'plain-text/1', text: '' },
      asset_refs: {}, requirements: {}, acceptance: {}, relationships: {}, contract: { inputs: {}, outputs: {}, failures: {} } } },
      authorities: { scopes: [{ block: 'app', selectors: ['author'] }], release: ['author'], guardians: [] }, deleted_ids: [] };
    assert.equal((await dispatch('init', baseline)).status, 200);
    const layer = { id: 'L-private', revision: 1, model_version: BLOCK_MODEL, owner: 'author', baseline: 'R-start@1',
      intent: 'Revise synthetic purpose.', created_blocks: [], changes: [{ op: 'set_item', block: 'app', path: 'purpose',
        expected: { kind: 'value', value: baseline.blocks.app.purpose }, value: 'Retain checked synthetic project.' }],
      acceptance: [], read_set: [], requires_layers: [], assumptions: [], resolution_proposals: [], derived_from: null };
    assert.equal((await dispatch('layer.create', layer)).status, 200);
    assert.equal((await dispatch('layer.create', { ...layer, id: 'L-second' })).status, 200);
    const connection = await send('/studio/v1/connection', undefined, cookie);
    const generation = connection.data.data.source.registry_generation;
    const records = '/studio/v1/records?type=release&generation=' + generation;
    const layers = '/studio/v1/records?type=layer&generation=' + generation;
    const before = await send(records, undefined, cookie); assert.equal(before.status, 200); assert(before.text.includes('R-start@1'));
    const page = await send(layers + '&limit=1', undefined, cookie);
    assert.equal(page.status, 200); const cursor = page.data.data.next_cursor; assert(cursor);
    policy.generation = 2; policy.grants[0].operations = ['capabilities'];
    await writeFile(config.policy_file, JSON.stringify(policy), { mode: 0o600 });
    assert.equal(accounts.accounts[0].active, true);
    for (const route of [records, layers + '&limit=1&cursor=' + cursor, '/studio/v1/connection']) {
      const denied = await send(route, undefined, cookie);
      assert.equal(denied.status, 403, denied.text); assert.equal(denied.data.error.code, 'OPERATION_FORBIDDEN');
      assert.equal(denied.text.includes('R-start@1') || denied.text.includes('L-private@1'), false);
    }
    policy.generation = 3; policy.grants[0].operations = [...operations];
    await writeFile(config.policy_file, JSON.stringify(policy), { mode: 0o600 });
    const old = await send(records, undefined, cookie); assert.notEqual(old.status, 200);
    const refreshed = await send('/studio/v1/connection', undefined, cookie); assert.equal(refreshed.status, 200, refreshed.text);
    const current = '/studio/v1/records?type=release&generation=' + refreshed.data.data.source.registry_generation;
    const currentLayers = '/studio/v1/records?type=layer&generation=' + refreshed.data.data.source.registry_generation;
    const staleCursor = await send(currentLayers + '&limit=1&cursor=' + cursor, undefined, cookie);
    assert.equal(staleCursor.status, 409, staleCursor.text); assert.equal(staleCursor.data.error.code, 'STALE_CURSOR');
    const restored = await send(current, undefined, cookie); assert.equal(restored.status, 200); assert(restored.text.includes('R-start@1'));
  } finally { await host.close(); }
});
