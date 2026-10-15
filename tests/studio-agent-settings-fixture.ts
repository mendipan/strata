import { request } from 'node:http';
import path from 'node:path';
import { agentFixture } from './studio-agent-connection-fixture.js';
import { managerHostFixture } from './studio-manager-host-fixture.js';
import { AgentConnectionStore, initialAgentState } from '../src/explorer/agent-connection-store.js';
import { OwnerAgentSettings } from '../src/explorer/agent-settings.js';
import { OwnerAccess } from '../src/explorer/owner-access.js';
import { writePrivate } from '../src/explorer/owner-files.js';
import { startExplorer } from '../src/explorer/host.js';
import { ExplorerReader } from '../src/explorer/read.js';
import { TestSource, sample } from './explorer-fixture.js';

// Real owner enrollment/session and filesystem with public replaced discovery.
// Never selects production target/auth, initializes production state or fetches.
export async function agentSettingsFixture(configured = true) {
  const base = await managerHostFixture(); await base.server.close();
  const agent = await agentFixture(), active = (await base.bootstrapState.owner())!;
  const scope = { ...agent.scope, installation_id: active.manifest.installation_id, owner_id: active.owner_id };
  const initial = initialAgentState(scope);
  await writePrivate(path.join(agent.stateDirectory, 'genesis.json'), initial);
  await writePrivate(path.join(agent.stateDirectory, 'state.json'), initial);
  const store = new AgentConnectionStore(agent.stateDirectory, scope), manager = agent.make(store);
  const settings = new OwnerAgentSettings(manager, ['synthetic']);
  const owner = new OwnerAccess(base.bootstrapState, { publicOrigin: base.origin, trustedProxyAddresses: ['127.0.0.1'] }, () => Date.parse(agent.iso()), { connections: base.manager, ...(configured ? { agents: settings } : {}) });
  const server = await startExplorer(new ExplorerReader(new TestSource(await sample())), { assets: path.resolve('explorer'), owner });
  const browser = () => {
    const cookies = new Map<string,string>();
    const send = (route: string, method = 'GET', input?: unknown, csrf?: string, extra: Record<string,string> = {}) => new Promise<{ status: number; data: any; text: string; headers: any }>((resolve,reject) => {
      const req = request(server.origin + route, { method, headers: { host: 'studio.example.test', 'x-forwarded-proto': 'https', ...(method === 'POST' ? { origin: base.origin, 'content-type': 'application/json' } : {}), cookie: [...cookies].map(([k,v]) => k + '=' + v).join('; '), ...(csrf ? { 'x-studio-csrf': csrf } : {}), ...extra } }, res => {
        for (const raw of res.headers['set-cookie'] ?? []) { const pair = raw.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0,i), pair.slice(i+1)); }
        let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode!, data, text, headers: res.headers }); });
      }); req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
    });
    return { send, cookies };
  };
  const b = browser();
  const login = async () => { const pre = await b.send('/studio/owner/session'); const r = await b.send('/studio/owner/login', 'POST', { username: 'manager.owner', password: base.password }, pre.data.csrf); if (r.status !== 200) throw Error(r.text); return r.data; };
  const status = () => b.send('/studio/v1/owner/agents');
  return { ...base, server, owner, agent, agentManager: manager, agentStore: store, settings, b, browser, login, status };
}
