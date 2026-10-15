import { createInterface } from 'node:readline';
import { z } from 'zod';
import { canonical, contentLayerSchema } from './model.js';

const endpoint = process.env.STRATA_DEMO_ACTOR_ENDPOINT;
const capability = process.env.STRATA_DEMO_ACTOR_CAPABILITY;
const toolName = 'strata_operation';
const commandNames = ['status', 'inspect', 'conflicts', 'layer.create', 'layer.revise', 'layer.publish'];
const MAX_LINE_BYTES = 64 * 1024;
const { $schema: _schemaDialect, ...layerInputSchema } = z.toJSONSchema(contentLayerSchema);
const toolInputSchema = { type: 'object', additionalProperties: false, required: ['command', 'input'], properties: {
  command: { type: 'string', enum: commandNames },
  input: { type: 'object', additionalProperties: false,
    description: 'status: {} or target. inspect: type and ref, optional limit/cursor. conflicts: target. layer.create: record. layer.revise: record and previous. layer.publish: ref. Supply only the fields for your command.',
    properties: {
      target: { type: 'string' }, type: { type: 'string' }, ref: { type: 'string' },
      limit: { type: 'integer', minimum: 1 }, cursor: { type: 'string' }, previous: { type: 'string' },
      record: { ...layerInputSchema, description: 'Complete owned Layer. Preserve the assigned task values exactly, including empty assumptions and acceptance arrays. Write your own intent and pin required reads.' }
    }
  }
} };
let shuttingDown = false;

function send(message: unknown) { process.stdout.write(JSON.stringify(message) + '\n'); }
function rpcError(id: unknown, code: number, message: string) { send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }); }

async function routeTool(args: unknown) {
  if (!endpoint || !capability || !/^http:\/\/127\.0\.0\.1:\d+\/strata_operation$/.test(endpoint)) throw new Error('ACTOR_ROUTE_UNAVAILABLE');
  if (!args || typeof args !== 'object' || Array.isArray(args) || canonical(Object.keys(args as object).sort()) !== canonical(['command','input']) ||
      !commandNames.includes(String((args as any).command)) || !(args as any).input || typeof (args as any).input !== 'object' || Array.isArray((args as any).input))
    throw new Error('ACTOR_ENVELOPE_REFUSED');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
      body: canonical(args), signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`ACTOR_TOOL_REFUSED_${response.status}`);
    const payload = await response.json() as any;
    if (!payload || !Object.hasOwn(payload, 'result')) throw new Error('ACTOR_TOOL_RESPONSE_REFUSED');
    const result = payload.result?.outcome ?? payload.result;
    // Diagnose only after the authoritative host has counted and refused the call.
    // Never repair a model record or bypass identity, scope or assignment checks.
    if (result?.ok === false && ['layer.create', 'layer.revise'].includes((args as any).command)) {
      const parsed = contentLayerSchema.safeParse((args as any).input.record);
      if (!parsed.success) return { ...result, error: { ...result.error,
        validation: parsed.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.').slice(0, 160), message: issue.message.slice(0, 160) })) } };
    }
    return result;
  } finally { clearTimeout(timer); }
}

async function handle(message: any) {
  if (!message || message.jsonrpc !== '2.0' || !('method' in message)) {
    if (message?.id !== undefined) rpcError(message.id, -32600, 'Invalid request.'); return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'strata-demo-local-actor', version: '1.0.0' } } }); return;
  }
  if (message.method === 'ping') { send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: toolName,
      description: 'Read or author only the fixed actor-owned Strata Layer through the local host.',
      inputSchema: toolInputSchema }] } }); return;
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== toolName) { rpcError(message.id, -32602, 'Only strata_operation is available.'); return; }
    try {
      const result = await routeTool(message.params.arguments);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        ...(result?.ok === false ? { isError: true } : {}) } });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ACTOR_TOOL_FAILED';
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true } });
    }
    return;
  }
  if (message.method === 'shutdown') { shuttingDown = true; send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
  if (message.method === 'exit') { shuttingDown = true; return; }
  if (message.id !== undefined) rpcError(message.id, -32601, 'Method not found.');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (shuttingDown) break;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) { process.exitCode = 2; break; }
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { rpcError(null, -32700, 'Parse error.'); continue; }
  void handle(message).catch(() => rpcError((message as any)?.id, -32603, 'Internal tool-server error.'));
}
