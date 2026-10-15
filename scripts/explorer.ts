import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL, digest } from '../src/model.js';
import { problem, safeJson } from '../src/explorer/contract.js';
import { loadConfig, RegistrySource, RestArtifactsReader, type ExplorerSource } from '../src/explorer/source.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerConnections } from '../src/explorer/connections.js';
import { parseExplorerArgs, reviewGrant } from '../src/explorer/launch.js';
import type { ReviewDraftGrant } from '../src/explorer/read.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function launchExplorer(args:string[]) {
  const options=parseExplorerArgs(args);
  if(options.help) {process.stdout.write('Strata Studio: node dist/scripts/explorer.js [--sample | --config ABSOLUTE_PATH --allow-remote-read] [--port 4173]\nConfig validation only: --config ABSOLUTE_PATH --check-config\nOptional repository pin: --expect-repository-id ID\nExact unpublished Layer review: --review-draft REF --review-sha256 SHA256 --expect-repository-id ID\nNo source records or provider credentials are persisted in the browser.\n');return;}
  const port=options.port;
  let source:ExplorerSource;
  let reviewDraft:ReviewDraftGrant|undefined;
  let sessionMs:number|undefined;
  let authenticationAvailable: (() => boolean) | undefined;
  if(options.sample) {
    const records=safeJson(await readFile(path.join(root,'explorer/sample-records.json'),'utf8'));
    source={connection:{connection_id:'sample-booking',project_id:'explorer-sample',display_name:'Booking project',model_version:MODEL},assertAuthorized(){},async load(){return {records:structuredClone(records),assetBytes:new Map(),source:{mode:'sample',registry_kind:'synthetic-fixture',registry_generation:digest(records),verified_at:new Date().toISOString(),freshness:'fixed-snapshot',semantic_trust:'local-fixture'}};}};
  } else if(options.configPath) {
    const config=await loadConfig(options.configPath);
    if(options.checkConfig) {process.stdout.write('Connection shape and project binding verified locally; registry bytes, auth availability and provider access are unverified. No credential or network read performed.\n');return;}
    if(!options.allowRemoteRead) throw new Error('Remote reads are gated. Supply --allow-remote-read only with a separately authorized read session.');
    reviewDraft=reviewGrant(config,options);
    sessionMs=Math.max(1,Math.min(8*60*60*1000,Date.parse(config.read_authorization.expires_at)-Date.now()));
    const readerPort=new RestArtifactsReader(config,async()=>{ const credential=process.env[config.auth_provider.variable];if(!credential) problem('SOURCE_AUTH',403,'Existing host authentication is unavailable.');return credential!; },fetch,options.expectedRepositoryId);
    authenticationAvailable=()=>!!process.env[config.auth_provider.variable];
    source=new RegistrySource(config,readerPort,undefined,()=>readerPort.assertAuthorized());
  } else {
    source={connection:{connection_id:'unconfigured',project_id:'unconfigured',display_name:'Connect a project locally',model_version:MODEL},assertAuthorized(){},async load(){return problem('CONNECTION_NOT_READY',503,'Configure a trusted Strata registry and an existing Artifacts read connection in the local host.');}};
  }
  const reader=new ExplorerReader(source,{reviewDraft});
  try {await reader.refresh();} catch { /* Serve honest unconfigured/error shell. Never fall back to sample. */ }
  const connections=new ExplorerConnections([{reader,provider:options.sample?'sample':options.configPath?'artifacts-rest':'unavailable',authenticationAvailable}]);
  const host=await startExplorer(reader,{port,assets:path.join(root,'explorer'),sessionMs,connections});
  // Only this private launch link contains the ephemeral local browser session.
  // Never print provider credentials, account bindings or underlying errors.
  process.stdout.write(`Strata Studio · ${options.sample?'Sample data':'Local read-only host'}\nPrivate local launch link: ${host.launchUrl}\nSession expires: ${host.expiresAt}\nKeep this terminal open. Ctrl+C closes the session.\n`);
  const stop=()=>{void host.close().then(()=>process.exit(0));}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)launchExplorer(process.argv.slice(2)).catch(()=>{process.stderr.write('Studio could not start. Check the local arguments, connection configuration and documented read gate. No automatic login or credential creation is available.\n');process.exitCode=1;});
