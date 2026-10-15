import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { fail } from '../src/model.js';
import { operatorEventPreview, operatorPromptPacket, operatorReplyTemplate, type OperatorDecisionArtifact } from '../src/integrated-demo-operator-reply.js';
import { integratedDemoSelectionReviewHtml } from '../src/integrated-demo-review.js';

const maxInputBytes = 20 * 1024 * 1024;
export type OperatorReplyTerminal = {
  stdin_is_tty: boolean;
  stdout_is_tty: boolean;
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  close?(): void;
};

async function readJson(file: string) {
  const bytes = await readFile(path.resolve(file));
  if (bytes.byteLength > maxInputBytes) fail('DEMO_OPERATOR_FILE_REFUSED', 4, 'Input file exceeds the local 20 MiB bound.');
  try { return JSON.parse(bytes.toString()); }
  catch { fail('DEMO_OPERATOR_FILE_REFUSED', 4, 'Input file is not valid JSON.'); }
}
async function writeNewText(file: string, text: string) {
  const target = path.resolve(file), handle = await open(target, 'wx', 0o600);
  let complete = false;
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); complete = true; }
  finally { await handle.close(); if (!complete) await unlink(target).catch(() => undefined); }
}
async function writeNewJson(file: string, value: unknown) { await writeNewText(file, JSON.stringify(value, null, 2) + '\n'); }

function interactiveTerminal(): OperatorReplyTerminal {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return { stdin_is_tty: process.stdin.isTTY === true, stdout_is_tty: process.stdout.isTTY === true,
    write: text => process.stdout.write(text), ask: prompt => readline.question(prompt), close: () => readline.close() };
}

export async function runOperatorReplyCli(argv: string[], now = Date.now(), suppliedTerminal?: OperatorReplyTerminal) {
  const [mode, statusPath, replyPath, outputPath] = argv;
  if (mode === 'packet' && statusPath && replyPath && !outputPath) {
    const description = await readJson(statusPath), packet = operatorPromptPacket(description);
    const output = { ...packet, reply_template: operatorReplyTemplate(packet),
      instructions: 'Review the complete decision object. Copy reply_template into a separate reply JSON file, fill every field there, and pass that reply file to event mode. Use only an allowed action. This file is operator-supplied input; runtime identity and authorship are not authenticated.' };
    await writeNewJson(replyPath, output); return { mode, output_path: path.resolve(replyPath), packet_digest: packet.packet_digest, live_authorized: false };
  }
  if (mode === 'review' && statusPath && replyPath && !outputPath) {
    const description = await readJson(statusPath), packet = operatorPromptPacket(description);
    await writeNewText(replyPath, integratedDemoSelectionReviewHtml(packet));
    return { mode, output_path: path.resolve(replyPath), packet_digest: packet.packet_digest, live_authorized: false, review_only: true };
  }
  if (mode === 'event' && statusPath && replyPath && outputPath) {
    const description = await readJson(statusPath), artifact = await readJson(replyPath);
    const output = operatorEventPreview(description, artifact, now);
    await writeNewJson(outputPath, output); return { mode, output_path: path.resolve(outputPath), event_type: output.event_type, live_authorized: false };
  }
  if (mode === 'interactive' && statusPath && replyPath && !outputPath) {
    const terminal = suppliedTerminal ?? interactiveTerminal();
    try {
      if (terminal.stdin_is_tty !== true || terminal.stdout_is_tty !== true)
        fail('DEMO_OPERATOR_TTY_REQUIRED', 7, 'Interactive reply capture requires both stdin and stdout to be attached to a terminal.');
      const description = await readJson(statusPath), packet = operatorPromptPacket(description);
      terminal.write('Current Workflow decision packet:\n' + JSON.stringify(packet, null, 2) + '\n\n');
      terminal.write('This local terminal check does not authenticate identity or prove consent; the operator label is self-declared.\n');
      const challenge = await terminal.ask('Type the exact packet digest to continue: ');
      if (challenge !== packet.packet_digest)
        fail('DEMO_OPERATOR_PACKET_CONFIRMATION_REFUSED', 4, 'The typed packet digest did not match the current decision packet.');
      terminal.write('Allowed actions: ' + packet.allowed_actions.join(', ') + '\n');
      const action = await terminal.ask('Action: ');
      if (!packet.allowed_actions.includes(action.trim() as OperatorDecisionArtifact['action']))
        fail('DEMO_OPERATOR_ACTION_REFUSED', 4, 'Action is not allowed by the current packet.');
      const responseText = await terminal.ask('Response text: ');
      if (!responseText.trim() || responseText.length > 2048)
        fail('DEMO_OPERATOR_RESPONSE_REFUSED', 4, 'Response text must be non-empty and at most 2048 characters.');
      const operatorLabel = await terminal.ask('Operator label (self-declared): ');
      if (!operatorLabel.trim() || operatorLabel.length > 128)
        fail('DEMO_OPERATOR_LABEL_REFUSED', 4, 'Operator label must be non-empty and at most 128 characters.');
      const artifact: OperatorDecisionArtifact = { format: 'strata.integrated-demo-operator-reply/1', run_id: packet.run_id,
        packet_digest: packet.packet_digest, action: action.trim() as OperatorDecisionArtifact['action'],
        response_text: responseText, operator_label: operatorLabel, recorded_at: new Date(now).toISOString(),
        capture_method: 'local-interactive-terminal' };
      operatorEventPreview(description, artifact, now);
      await writeNewJson(replyPath, artifact);
      return { mode, output_path: path.resolve(replyPath), packet_digest: packet.packet_digest, live_authorized: false,
        attribution: 'local interactive terminal; identity and consent are not authenticated' };
    } finally { terminal.close?.(); }
  }
  fail('DEMO_OPERATOR_USAGE', 2,
    'Usage: integrated-demo-operator-reply packet <workflow-description.json> <new-packet-file.json> | review <workflow-description.json> <new-review.html> | interactive <workflow-description.json> <new-reply-artifact.json> | event <workflow-description.json> <reply-artifact.json> <new-event-preview.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runOperatorReplyCli(process.argv.slice(2)); console.log(JSON.stringify(result));
}
