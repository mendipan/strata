import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Buffer } from 'node:buffer';
import { OwnerConnectionClient } from '../src/explorer/connection-client.js';
import { managementActions } from '../src/explorer/connection-policy.js';
import { ExplorerError,problem,safeJson } from '../src/explorer/contract.js';

export async function passwordInput(fromStdin:boolean,input:NodeJS.ReadStream=process.stdin,output:NodeJS.WriteStream=process.stderr):Promise<string>{
  if(fromStdin){input.setEncoding('utf8');let text='';for await(const chunk of input){text+=chunk.toString();if(Buffer.byteLength(text)>1024)problem('INVALID_INPUT',400,'Protected password stdin exceeds its bound.');}return text.replace(/\r?\n$/,'');}
  if(!input.isTTY)problem('INVALID_INPUT',400,'Use an attended terminal or explicit protected --password-stdin.');
  output.write('Studio owner password: ');input.setEncoding('utf8');input.setRawMode(true);input.resume();
  return new Promise((resolve,reject)=>{let text='';const finish=(error?:Error)=>{input.removeListener('data',data);input.setRawMode(false);input.pause();output.write('\n');if(error)reject(error);else resolve(text);};const data=(chunk:string)=>{for(const char of chunk){if(char==='\u0003'){finish(new Error('Cancelled'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')text=[...text].slice(0,-1).join('');else if(char>=' ')text+=char;if(Buffer.byteLength(text)>1024){finish(new Error('Bounded password input exceeded'));return;}}};input.on('data',data);});
}
export async function launchConnectionCli(args:string[]){
  let client:OwnerConnectionClient|undefined;
  try{
    const action=args.shift();if(!action||!['status','outcome',...managementActions].includes(action))problem('INVALID_INPUT',400,'Use studio connections status|outcome|create|test|select|connect|disconnect|renew|remove.');
    const flags:Record<string,string|boolean>={};for(let i=0;i<args.length;i++){const key=args[i];if(!['--origin','--username','--file','--request-id','--password-stdin'].includes(key)||Object.hasOwn(flags,key))problem('INVALID_INPUT',400,'Unsupported or repeated connection CLI option.');if(key==='--password-stdin')flags[key]=true;else{const value=args[++i];if(!value||value.startsWith('--'))problem('INVALID_INPUT',400,'Connection CLI option requires a value.');flags[key]=value;}}
    if(typeof flags['--origin']!=='string')problem('INVALID_INPUT',400,'Specify the approved --origin HTTPS URL.');client=new OwnerConnectionClient(flags['--origin']);
    let username=flags['--username'];if(typeof username!=='string'){if(!process.stdin.isTTY)problem('INVALID_INPUT',400,'Supply the nonsecret --username.');const prompt=createInterface({input:process.stdin,output:process.stderr});try{username=await prompt.question('Studio owner name: ');}finally{prompt.close();}}
    const password=await passwordInput(!!flags['--password-stdin']);await client.login(username,password);
    let result;
    if(action==='status'){if(flags['--file']||flags['--request-id'])problem('INVALID_INPUT',400,'Status accepts no action file or request ID.');result=await client.status();}
    else if(action==='outcome'){if(typeof flags['--request-id']!=='string'||flags['--file'])problem('INVALID_INPUT',400,'Outcome needs only --request-id.');result=await client.outcome(flags['--request-id']);}
    else{if(typeof flags['--file']!=='string'||flags['--request-id'])problem('INVALID_INPUT',400,'A mutation requires --file with the exact nonsecret action/revision/request ID.');const bytes=await readFile(flags['--file']);if(bytes.byteLength>1024)problem('INVALID_INPUT',400,'Action file exceeds one KiB.');const body=safeJson(new TextDecoder('utf8',{fatal:true}).decode(bytes),1024);if(body.action!==action)problem('INVALID_INPUT',400,'Action file and CLI operation must match.');result=await client.action(body);}
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){process.stderr.write(JSON.stringify({error:{code:error instanceof ExplorerError?error.code:'SOURCE_UNAVAILABLE',message:'Connection CLI did not confirm completion. Inspect current status and the exact request outcome before retrying.'}})+'\n');process.exitCode=1;}
  finally{await client?.close().catch(()=>{});}
}
