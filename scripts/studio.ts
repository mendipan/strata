import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parse } from '../src/model.js';
import { StudioCommands, STUDIO_COMMANDS } from '../src/explorer/commands.js';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerConnections } from '../src/explorer/connections.js';
import { launchExplorer } from './explorer.js';

// Trusted console inputs only. This config refers to an already assigned local
// session; it creates no account, grant, provider credential or source association.
const schema=z.object({format:z.literal('strata-studio-local/1'),selector_environment:z.string().regex(/^STRATA_STUDIO_[A-Z0-9_]+$/),operations:z.array(z.enum(STUDIO_COMMANDS)).max(32),output_slots:z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().regex(/^\.strata\/[A-Za-z0-9_./-]+$/)).default({})}).strict();
export async function launchStudio(args:string[]) {
  if(!args.includes('--project'))return launchExplorer(args);
  const input:Record<string,string>={};
  for(let i=0;i<args.length;i++){const key=args[i];if(!['--project','--write-config','--port'].includes(key)||input[key]||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid Studio argument.');input[key]=args[++i];}
  const root=path.resolve(input['--project']),config=JSON.parse(await readFile(path.join(root,'strata.config.json'),'utf8'));
  if(!input['--write-config']||!path.isAbsolute(input['--write-config']))throw Error('An explicit absolute local write configuration is required.');
  const writes=parse(schema,JSON.parse(await readFile(input['--write-config'],'utf8'))),selector=process.env[writes.selector_environment];
  if(!selector)throw Error('The already assigned server-side session is unavailable.');
  const port=input['--port']??'4173';if(!/^\d+$/.test(port)||+port>65535)throw Error('Invalid port.');
  const commands=new StudioCommands(config,selector,root,writes.operations,writes.output_slots);
  // An empty valid project still has a ready generation for initial authoring.
  await commands.reader.refresh();
  const connections=new ExplorerConnections([{reader:commands.reader,provider:'local-broker'}]);
  const host=await startExplorer(commands.reader,{port:+port,assets:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../explorer'),commands,connections});
  process.stdout.write(`Strata Studio — explicitly configured local session\nPrivate local launch link: ${host.launchUrl}\nSession expires: ${host.expiresAt}\n`);
  const stop=()=>{commands.close();void host.close().then(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)launchStudio(process.argv.slice(2)).catch(()=>{process.stderr.write('Studio could not start. Check the explicit local configuration, assigned session and running broker. No access was provisioned.\n');process.exitCode=1;});
