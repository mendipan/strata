import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { integratedDemoReplayData, renderIntegratedDemoReplayHtml, renderIntegratedDemoWorkflowSnapshotHtml } from '../src/integrated-demo-replay.js';
import { parseWorkflowSnapshot } from '../src/integrated-demo-visualization.js';

async function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  if (args[0] === 'snapshot') {
    if (!args[1] || args.length > 3) throw new Error('Usage: integrated-demo-replay-preview snapshot <saved-workflow-description.json> [new-output.html]');
    const inputPath = resolve(args[1]);
    const outputPath = resolve(args[2] ?? join(tmpdir(), `strata-workflow-snapshot-${randomUUID()}.html`));
    const templatePath = resolve(root, 'demo/integrated-demo-workflow-snapshot.template.html');
    const input = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
    const template = await readFile(templatePath, 'utf8');
    const html = renderIntegratedDemoWorkflowSnapshotHtml(template, parseWorkflowSnapshot(input));
    await writeFile(outputPath, html, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`Read-only imported Workflow snapshot preview (origin unverified; no provider call): ${outputPath}\n`);
    return;
  }
  if (args.length > 2) throw new Error('Usage: integrated-demo-replay-preview [fixture-bundle.json] [new-output.html] | snapshot <saved-workflow-description.json> [new-output.html]');
  const inputPath = resolve(args[0] ?? join(root, 'tests/fixtures/demo/rehearsal.json'));
  const outputPath = resolve(args[1] ?? join(tmpdir(), `strata-integrated-demo-replay-${randomUUID()}.html`));
  const templatePath = resolve(root, 'demo/integrated-demo-replay.template.html');
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
  const template = await readFile(templatePath, 'utf8');
  const html = renderIntegratedDemoReplayHtml(template, integratedDemoReplayData(input));
  await writeFile(outputPath, html, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`Read-only synthetic replay preview: ${outputPath}\n`);
}

main().catch(error => {
  process.stderr.write(`Could not prepare local replay preview: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});