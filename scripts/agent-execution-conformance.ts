// ADAPTER-KIT offline conformance runner (docs/agents/EXECUTION_CONTRACT.md §8). It
// replays the kit scenarios against a supplied execution/1 adapter subject and
// prints a bounded receipt. Evidence is synthetic and offline only: no credentials,
// network, provider SDK, model call or child process is involved (contract §9).

import { pathToFileURL } from 'node:url';
import { kitHarness, kitScenarios, syntheticKitSubject, type KitSubject } from '../tests/fixtures/agent-execution-kit.js';

export interface KitCheck { name: string; contract: string; ok: boolean; detail?: string }
export interface KitReceipt { subject: string; checks: KitCheck[]; failures: number }

/** Runs every offline scenario against the subject adapter and reports a receipt. */
export async function checkAgentExecutionKit<J>(subject: KitSubject<J>): Promise<KitReceipt> {
  const checks: KitCheck[] = [];
  for (const scenario of kitScenarios) {
    try {
      await scenario.run(await kitHarness(subject));
      checks.push({ name: scenario.name, contract: scenario.contract, ok: true });
    } catch (error) {
      // Bounded, redacted detail only: no stacks, bodies, URLs or prompts enter it (§6).
      const detail = 'Synthetic conformance scenario failed.';
      checks.push({ name: scenario.name, contract: scenario.contract, ok: false, detail });
    }
  }
  return { subject: subject.name, checks, failures: checks.filter(check => !check.ok).length };
}

async function main(): Promise<number> {
  const receipt = await checkAgentExecutionKit(syntheticKitSubject);
  console.log(JSON.stringify({
    subject: receipt.subject, checks: receipt.checks.length, failures: receipt.failures,
    failed: receipt.checks.filter(check => !check.ok).map(check => `${check.name} (${check.contract}): ${check.detail}`),
  }));
  return receipt.failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
