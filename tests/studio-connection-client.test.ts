import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {OwnerConnectionClient} from '../src/explorer/connection-client.js';
import {PassThrough} from 'node:stream';
import {passwordInput} from '../scripts/studio-connections.js';
test('CLI uses current owner cookies/CSRF and exact action payload; outcome lookup is read-only',async()=>{
  const calls:{url:string;options:RequestInit}[]=[],secret='s'.repeat(43),csrf='c'.repeat(43),id=randomUUID();
  const transport:typeof fetch=async(input,options={})=>{const url=String(input);calls.push({url,options});const headers=new Headers({'content-type':'application/json'});
    if(url.endsWith('/session')){headers.append('set-cookie','__Host-strata_pre='+secret+'; Secure; HttpOnly; SameSite=Strict');return new Response(JSON.stringify({csrf}),{headers});}
    if(url.endsWith('/login')){assert.equal(new Headers(options.headers).get('origin'),'https://studio.example.test');assert.equal(new Headers(options.headers).get('cookie'),'__Host-strata_pre='+secret);headers.append('set-cookie','__Host-strata_owner='+secret+'; Secure; HttpOnly; SameSite=Strict');return new Response(JSON.stringify({authenticated:true,csrf}),{headers});}
    assert.equal(new Headers(options.headers).get('cookie'),'__Host-strata_pre='+secret+'; __Host-strata_owner='+secret);return new Response(JSON.stringify({format:'synthetic-masked-status',state:'completed'}),{headers});
  };
  const client=new OwnerConnectionClient('https://studio.example.test',transport);await client.login('synthetic.owner','Synthetic test password');const body={action:'disconnect',connection_id:randomUUID(),revision:2,request_id:id};await client.action(body);assert.deepEqual(JSON.parse(calls[2].options.body as string),body);assert.equal(new Headers(calls[2].options.headers).get('x-studio-csrf'),csrf);await client.outcome(id);assert.equal(calls[3].options.method,'GET');assert.equal(calls[3].options.body,undefined);assert.ok(calls.every(c=>c.options.redirect==='manual'));await client.close();assert.equal(calls.length,5);
});
test('CLI rejects origin, action secrets, changed shape and oversized response before repeat dispatch',async()=>{
  assert.throws(()=>new OwnerConnectionClient('http://studio.example.test'));assert.throws(()=>new OwnerConnectionClient('https://studio.example.test/path'));assert.throws(()=>new OwnerConnectionClient('https://user:secret@studio.example.test'));
  let calls=0;const client=new OwnerConnectionClient('https://studio.example.test',async()=>{calls++;return new Response('x'.repeat(65537));});
  await assert.rejects(async()=>client.action({action:'create',revision:0,request_id:randomUUID(),profile_id:'p',ticket_id:randomUUID(),label:'a',token:'never'}));assert.equal(calls,0);await assert.rejects(client.status(),(e:any)=>e.code==='READ_LIMIT');assert.equal(calls,1);
});

test('no-echo password entry handles split UTF8 after a name prompt and restores terminal on cancel',async()=>{
  const input=new PassThrough(),output=new PassThrough(),modes:boolean[]=[];let rendered='';output.on('data',chunk=>rendered+=chunk.toString());
  Object.assign(input,{isTTY:true,setRawMode:(mode:boolean)=>{modes.push(mode);return input;}});input.setEncoding('utf8');
  const password='Synthetic 日本 password',entered=passwordInput(false,input as unknown as NodeJS.ReadStream,output as unknown as NodeJS.WriteStream),bytes=Buffer.from(password);
  for(const byte of bytes)input.write(Buffer.from([byte]));input.write('\r');assert.equal(await entered,password);assert.deepEqual(modes,[true,false]);assert.ok(!rendered.includes(password));assert.equal(input.listenerCount('data'),0);
  const cancelled=passwordInput(false,input as unknown as NodeJS.ReadStream,output as unknown as NodeJS.WriteStream);input.write('\u0003');await assert.rejects(cancelled);assert.equal(modes.at(-1),false);assert.equal(input.listenerCount('data'),0);
});

test('protected stdin decodes split UTF8 without echo or persistence',async()=>{
  const input=new PassThrough(),output=new PassThrough(),password='Synthetic 日本 protected input',entered=passwordInput(true,input as unknown as NodeJS.ReadStream,output as unknown as NodeJS.WriteStream);
  for(const byte of Buffer.from(password))input.write(Buffer.from([byte]));input.end('\r\n');assert.equal(await entered,password);assert.equal(output.readableLength,0);
});
