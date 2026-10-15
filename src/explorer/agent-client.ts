import { OwnerSessionClient } from './connection-client.js';
import { agentConnectionActionSchema } from './agent-connection.js';
import { agentFailure } from './agent-connection-store.js';

// Thin client of the same owner routes, authority, CAS and retained receipts.
// No file mutator, actor key, provider credential, URL or execution authority.
export class OwnerAgentClient extends OwnerSessionClient {
  status() { return this.send('/studio/v1/owner/agents'); }
  action(input: unknown) {
    const parsed = agentConnectionActionSchema.safeParse(input);
    if (!parsed.success) return agentFailure('INVALID_INPUT', 400);
    return this.send('/studio/v1/owner/agents', parsed.data);
  }
  outcome(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return agentFailure('INVALID_INPUT', 400);
    return this.send('/studio/v1/owner/agents/operations/' + id);
  }
}
