import { StrictArtifacts } from './artifacts-fixture.js';
import { artifactsTestFixture } from '../src/artifacts-test-fixture.js';
import type { TestGrant, TestNamespace } from '../src/artifacts-test-worker.js';

export function workerGrant(): TestGrant {
  const run_id = 'a0b1c2d3e4f56789', fixture = artifactsTestFixture();
  return { format: 'strata-artifacts-workflow-grant/1', approved: true, approval_id: 'LOCAL-TEST-ONLY', run_id,
    account_id: 'a'.repeat(32), namespace: `strata-test-${run_id}`, repository: `run-${run_id}`, worker: `strata-artifacts-test-${run_id}`,
    project_id: fixture.projectId, source_digest: 'b'.repeat(64), fixture_digest: fixture.fixtureDigest,
    workflow: `strata-artifacts-flow-${run_id}`, instance_id: `run-${run_id}`,
    starts_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 590000).toISOString() };
}
export class WorkerArtifactsFixture {
  strict = new StrictArtifacts(); exists = false; calls: string[] = []; initialRevoked = 0; failInitialRevoke = false;
  constructor(readonly grant = workerGrant()) {}
  get remote() { const g = this.grant; return `https://${g.account_id}.artifacts.cloudflare.net/git/${g.namespace}/${g.repository}.git`; }
  namespace: TestNamespace = {
    create: async name => {
      if (name !== this.grant.repository) throw new Error('wrong repository'); this.calls.push('create');
      if (this.exists) throw Object.assign(new Error('never return this provider text'), { code: 10201 });
      this.exists = true; return { name, remote: this.remote, token: 'LOCAL-INITIAL-TOKEN' };
    },
    get: async name => {
      if (name !== this.grant.repository || !this.exists) throw new Error('wrong/missing repository'); this.calls.push('get');
      const repo = await this.strict.get('strata-smoke');
      return { ...repo,
        info: async () => { const info = await repo.info(); return { ...info, remote: this.strict.wrongRemote ? info.remote : this.remote }; },
        revokeToken: async token => {
          if (token === 'LOCAL-INITIAL-TOKEN') { this.calls.push('revokeInitial'); if (this.failInitialRevoke) throw new Error('LOCAL-INITIAL-TOKEN'); this.initialRevoked++; return true; }
          return repo.revokeToken(token);
        }
      };
    }
  };
  transport = async (request: Request) => {
    const url = new URL(request.url), suffix = url.pathname.slice(`/git/${this.grant.namespace}/${this.grant.repository}.git`.length);
    return this.strict.transport(new Request(`https://account.artifacts.cloudflare.net/git/default/strata-smoke.git${suffix}${url.search}`, request));
  };
  event() { return { workflowName:this.grant.workflow, instanceId:this.grant.instance_id, timestamp:new Date(Date.now()), payload:{run_id:this.grant.run_id} }; }
  env() { return { ARTIFACTS: this.namespace, STRATA_TEST_GRANT: JSON.stringify(this.grant) }; }
}
