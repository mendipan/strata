import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MODEL } from '../src/model.js';
import { problem, safeJson } from '../src/explorer/contract.js';
import { loadConfig, RegistrySource, RestArtifactsReader, trustedFile, type ExplorerSource } from '../src/explorer/source.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerConnections } from '../src/explorer/connections.js';
import { CredentialApi, credentialStoreConfigSchema, fileCredentialComponents } from '../src/explorer/credential-api.js';
import { BootstrapState, browserOwnerConfigSchema } from '../src/explorer/bootstrap-state.js';
import { OwnerAccess } from '../src/explorer/owner-access.js';
import { FileReadBudget } from '../src/explorer/read-budget.js';
import { sourceManagementConfigSchema, createManagedOwner } from '../src/explorer/managed-host.js';
import { workspaceConfigSchema,runWorkspaceStudio } from '../src/explorer/workspace-host.js';

import { namespaceConfigSchema } from '../src/explorer/namespace-policy.js';
import { runNamespaceStudio } from '../src/explorer/namespace-host.js';
import { studioAgentsHostSchema } from '../src/studio-agents/host.js';
import { namespaceLocalBuildHostSchema, namespaceLocalBuildInstallation } from '../src/explorer/namespace-build-installation.js';

// The installed namespace factory is also an offline synthetic acceptance port.
// Exporting it creates no listener, session, grant or provider call.
export { runNamespaceStudio };


export const hostedConfigSchema = z.object({
  format: z.literal('strata-studio-host/1'),
  public_origin: z.string(), trusted_proxy_addresses: z.array(z.string()).min(1).max(8),
  port: z.number().int().min(1).max(65535),
  access_key_hash_file: z.string().optional(),
  connection_config: z.string().optional(),
  expected_repository_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
  read_budget_file: z.string().optional(),
  credential_store: credentialStoreConfigSchema.optional(),
  browser_owner: browserOwnerConfigSchema.optional(),
  source_management: sourceManagementConfigSchema.optional(),
  workspace:workspaceConfigSchema.optional(),
  namespace:namespaceConfigSchema.optional(),
  studio_agents:studioAgentsHostSchema.optional(),
  namespace_local_build:namespaceLocalBuildHostSchema.optional(),
}).strict();

export async function loadHostedConfig(filename: string) {
  const config = hostedConfigSchema.parse(safeJson(await trustedFile(filename, 16384), 16384));
  if(config.namespace_local_build&&!config.namespace)throw new Error('Local Build launcher configuration requires namespace mode.');
  if(config.studio_agents&&!config.namespace)throw new Error('Agent hosting requires the reviewed namespace factory.');
  if(config.namespace&&(!config.browser_owner||config.workspace||config.source_management||config.connection_config||config.expected_repository_id||config.read_budget_file||config.access_key_hash_file||config.credential_store))throw new Error('Namespace mode requires the sealed owner and a distinct catalog; other storage modes cannot be mixed.');
  if(config.workspace&&(!config.browser_owner||config.source_management||config.connection_config||config.expected_repository_id||config.read_budget_file||config.access_key_hash_file||config.credential_store))throw new Error('Workspace mode requires the sealed browser owner and cannot mix legacy reader or managed source modes.');
  if(config.source_management && (!config.browser_owner || config.connection_config || config.expected_repository_id || config.read_budget_file)) throw new Error('Managed sources require browser owner mode and cannot mix the legacy source triplet.');
  if (!!config.connection_config !== !!config.expected_repository_id) throw new Error('Hosted source requires a repository ID pin.');
  if (!!config.connection_config !== !!config.read_budget_file) throw new Error('Hosted source requires protected persistent read accounting.');
  if (config.read_budget_file) {
    const filename = config.read_budget_file;
    if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) throw new Error('Read accounting requires a canonical absolute path.');
    const directory = path.dirname(filename);
    const protectedPaths = [config.connection_config!, config.access_key_hash_file,
      config.credential_store?.directory, config.credential_store?.unlock_key_file,
      config.credential_store?.manager_key_hash_file,
      ...(config.browser_owner ? Object.values(config.browser_owner) : [])].filter((p): p is string => typeof p === 'string');
    for (const other of protectedPaths) {
      const nested = (a: string, b: string) => { const relative = path.relative(a, b); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
      if (nested(directory, other) || nested(other, directory)) throw new Error('Read accounting must be separate from protected connection, owner and credential paths.');
    }
  }
  if(config.browser_owner&&(config.access_key_hash_file||config.credential_store))throw new Error('Browser owner mode cannot mix legacy access or credential-manager configuration.');
  let accessKeySha256: string | undefined;
  if (config.access_key_hash_file) {
    accessKeySha256 = (await trustedFile(config.access_key_hash_file, 128)).trim();
    const metadata = await stat(config.access_key_hash_file);
    if (process.platform !== 'win32' && (metadata.mode & 0o077)) throw new Error('Studio access key hash must be private.');
    if (!/^[a-f0-9]{64}$/.test(accessKeySha256)) throw new Error('Studio access key hash is invalid.');
  }
  return { config, accessKeySha256 };
}

export async function runHostedStudio(filename: string, assets: string) {
  const { config, accessKeySha256 } = await loadHostedConfig(filename);
  if(config.browser_owner&&process.platform!=='linux')throw new Error('Browser owner hosting requires Linux root-protected control and private service state.');
  const credentialComponents = config.credential_store ? fileCredentialComponents(config.credential_store) : undefined;
  const ownerState=config.browser_owner?new BootstrapState(config.browser_owner,config.public_origin):undefined;
  if(config.namespace){
    const build=config.namespace_local_build?namespaceLocalBuildInstallation(config.namespace_local_build,[
      filename,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),...Object.values(config.namespace),...Object.values(config.browser_owner!),assets,
      ...(config.studio_agents?[config.studio_agents.directory]:[]),
    ].filter((p):p is string=>typeof p==='string')):undefined;
    return runNamespaceStudio(ownerState!,config.namespace,{publicOrigin:config.public_origin,trustedProxyAddresses:config.trusted_proxy_addresses},config.port,assets,undefined,undefined,undefined,config.studio_agents,build);
  }
  if(config.workspace)return runWorkspaceStudio(ownerState!,config.workspace,{publicOrigin:config.public_origin,trustedProxyAddresses:config.trusted_proxy_addresses},config.port,assets);
  if(ownerState)await ownerState.readyDirectories();
  let source: ExplorerSource, authenticationAvailable: (() => boolean) | undefined;
  if (config.connection_config) {
    const connection = await loadConfig(config.connection_config);
    const budget = new FileReadBudget(config.read_budget_file!, connection, config.expected_repository_id!);
    await budget.ready();
    const port = new RestArtifactsReader(connection, async () => {
      if (credentialComponents) return credentialComponents.store.withCredential(async credential => {
        if (!credential) problem('SOURCE_AUTH', 403, 'Saved host authentication is unavailable.');
        return credential;
      });
      if(ownerState){const owner=await ownerState.owner();if(!owner)problem('SOURCE_AUTH',403,'Owner setup must be completed before source access.');return ownerState.store(owner.manifest).withCredential(async credential=>{if(!credential)problem('SOURCE_AUTH',403,'Saved host authentication is unavailable.');return credential;});}
      const credential = process.env[connection.auth_provider.variable];
      if (!credential) problem('SOURCE_AUTH', 403, 'Existing host authentication is unavailable.');
      return credential;
    }, fetch, config.expected_repository_id, budget);
    // Encrypted-store readiness is verified only on explicit source reads;
    // reporting configured storage is not proof of a usable provider token.
    authenticationAvailable = credentialComponents||ownerState ? undefined : () => !!process.env[connection.auth_provider.variable];
    source = new RegistrySource(connection, port, undefined, () => port.assertAuthorized());
  } else source = { connection: { connection_id: 'unconfigured', project_id: 'unconfigured', display_name: 'Connect a project on the host', model_version: MODEL }, assertAuthorized() {}, async load() { return problem('CONNECTION_NOT_READY', 503, 'The owner must configure a trusted registry and bounded Artifacts read authorization on the host.'); } };
  const reader = new ExplorerReader(source);
  // No provider read happens at startup or before authenticated browser action.
  const connections = new ExplorerConnections([{ reader, provider: config.connection_config ? 'artifacts-rest' : 'unavailable', authenticationAvailable }]);
  const credentialOptions = { ...credentialComponents,
    changed: async () => { const status = connections.status(); await connections.action({ action: 'disconnect', connection_id: status.selected_connection_id, revision: status.revision }); },
    ...(config.connection_config ? { tester: async (signal: AbortSignal) => {
      const status = connections.status();
      if (signal.aborted) throw new Error('cancelled');
      await connections.action({ action: 'test', connection_id: status.selected_connection_id, revision: status.revision });
      const entry = connections.status().connections.find(connection => connection.connection_id === status.selected_connection_id);
      return { outcome: entry?.last_test?.outcome === 'passed' ? 'passed' as const : entry?.error?.code === 'SOURCE_AUTH' ? 'denied' as const : 'error' as const, verified_at: new Date().toISOString() };
    } } : {}),
  };
  if(ownerState){const hostedOptions={publicOrigin:config.public_origin,trustedProxyAddresses:config.trusted_proxy_addresses};const owner=config.source_management?createManagedOwner(ownerState,config.source_management,hostedOptions):new OwnerAccess(ownerState,hostedOptions,Date.now,credentialOptions);return startExplorer(reader,{port:config.port,assets,connections,owner});}
  const credentials=new CredentialApi(credentialOptions);
  return startExplorer(reader, { port: config.port, assets, connections, credentials, hosted: { publicOrigin: config.public_origin, trustedProxyAddresses: config.trusted_proxy_addresses, accessKeySha256 } });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--host-config' || !path.isAbsolute(args[1])) throw new Error('An explicit absolute hosted configuration is required.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const host = await runHostedStudio(args[1], path.join(root, 'explorer'));
  process.stdout.write('Strata Studio hosted service started on loopback. Configured model and authority determine available capabilities.\n');
  const stop = () => { void host.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('Studio could not start. Verify the protected host configuration and runtime.\n'); process.exitCode = 1;
});
