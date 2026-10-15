import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { getPlatformProxy, PlatformProxy } from 'wrangler';
import { ArtifactRegistryStore } from '../src/artifact-registry.js';
import { crc32 } from '../src/assets.js';
import { bootstrap, proposal } from '../src/fixtures.js';
import { assetDescriptorSchema, bytesDigest, canonical, digest, parse, StrataError, type Records } from '../src/model.js';
import { LOCAL_PROJECT } from '../src/security.js';
import { StrictArtifacts, budget } from '../tests/artifacts-fixture.js';

type Options = NonNullable<Parameters<typeof getPlatformProxy>[0]>;
export type LocalFactory = (options: Options) => Promise<Pick<PlatformProxy<{ STRATA_PROBE: string }>, 'env' | 'dispose'>>;
export const activationPlan = () => ({
  format: 'strata-artifacts-activation-preparation/1', live_enabled: false,
  installed_supported_api: 'wrangler@4.147.0 getPlatformProxy',
  remote_candidate: { remoteBindings: true, persist: false, envFiles: [], artifacts: [{ binding: 'ARTIFACTS', namespace: 'strata', remote: true }] },
  proposed_payload: { objects: 4, original_bytes_max: 131072, models: 0 },
  billing: { provider_invoice_cap_proven: false, setup_http_dispatches_bounded: false, preview_worker_billing_verified: false },
  blockers: ['ZERO_OVERAGE_UNVERIFIED', 'PREVIEW_SESSION_NOT_AUTHORIZED'],
  next_user_action: 'Obtain provider confirmation of zero incremental billing for the Artifacts-only Wrangler remote preview session, including setup, preview RPC requests/CPU and cleanup. Otherwise this route remains blocked under the zero-overage requirement.'
});

function syntheticPng() {
  const chunk = (name: string, body: Buffer) => {
    const n = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([n, body])));
    return Buffer.concat([size, n, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0]))), chunk('IEND', Buffer.alloc(0))]);
}

// Fixture-only preparation: no account identity, credential loader or live transport.
export async function runMock(fixture = new StrictArtifacts()) {
  const binary = syntheticPng(), binaryHash = bytesDigest(binary);
  const descriptor = parse(assetDescriptorSchema, {
    format: 'strata-asset/1', project_id: LOCAL_PROJECT, id: 'adapter_fixture_image', revision: 1, previous: null,
    title: 'Synthetic adapter fixture', access: 'project-private',
    source: { kind: 'local-created', provider: 'deterministic-test-fixture', attribution: 'Synthetic bytes', permitted_uses: ['internal-retention', 'backup'] },
    content_sha256: binaryHash, byte_length: binary.length, media_type: 'image/png', width: 1, height: 1,
    validation: 'bounded-structure/1', imported_by: 'fixture-asset-operator'
  });
  const records: Records = {
    'R0@1': { type: 'snapshot', published: true, data: bootstrap() },
    'adapter_fixture@1': { type: 'layer', published: false, data: proposal('adapter_fixture', 'fixture-author') },
    ['asset@' + digest(descriptor)]: { type: 'asset', published: true, data: descriptor }
  };
  const bytes = new Map([[binaryHash, new Uint8Array(binary)]]), runBudget = budget(50, 4 * 1024 * 1024);
  const store = () => new ArtifactRegistryStore(fixture.adapter(runBudget), LOCAL_PROJECT);
  const payloadBytes = Object.values(records).reduce((n, r) => n + Buffer.byteLength(canonical(r.data)), binary.length);
  assert.ok(payloadBytes <= 131072);
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-activation-mock-'));
  try {
    const first = await store().stage(records, bytes, { entries: {} });
    const file = path.join(root, 'locators.json'); await writeFile(file, canonical(first), { flag: 'wx' });
    // A fresh store loads only the persisted locators, with no local object fallback.
    const cold = await store().load(JSON.parse(await readFile(file, 'utf8')));
    assert.equal(canonical(cold.records), canonical(records)); assert.deepEqual(Buffer.from(cold.assetBytes.get(binaryHash)!), binary);
    // Explicit identical-batch retry must discover the original branch, without a second push.
    const retry = await store().stage(records, bytes, { entries: {} });
    assert.equal(canonical(retry.entries), canonical(first.entries));
    assert.equal(canonical(retry.asset_locators), canonical(first.asset_locators));
    assert.equal(canonical(retry.storage), canonical(first.storage)); assert.equal(retry.receipt?.reused, true);
    assert.equal(fixture.pushes, 1); assert.equal(fixture.revoked, 2);
    return { mode: 'strict-mock', objects: 4, original_bytes: payloadBytes, exact_cold_read: true, identical_retry_reused: true,
      pushes: fixture.pushes, tokens_revoked: fixture.revoked, capabilities_disposed: fixture.disposed,
      fixture_call_events: fixture.calls.length, budget: runBudget.snapshot(), cloudflare_calls: 0 };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const localFlags: Record<string, string> = {
  NODE_ENV: 'test', CLOUDFLARE_CF_FETCH_ENABLED: 'false', CI: 'true',
  WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_LEVEL: 'none'
};

export async function runLocalProxy(factory?: LocalFactory) {
  const previous = Object.fromEntries(Object.keys(localFlags).map(k => [k, process.env[k]]));
  const root = await mkdtemp(path.join(os.tmpdir(), 'strata-activation-local-'));
  let platform: Awaited<ReturnType<LocalFactory>> | undefined;
  try {
    Object.assign(process.env, localFlags);
    const configPath = path.join(root, 'wrangler.json');
    // Fixed variables-only config: no account, Artifacts, DO, service or remote resources.
    await writeFile(configPath, JSON.stringify({ name: 'strata-local-interface-probe', compatibility_date: '2026-10-03', send_metrics: false, vars: { STRATA_PROBE: 'local-only' } }), { flag: 'wx' });
    const options: Options = { configPath, envFiles: [], persist: false, remoteBindings: false };
    const create = factory ?? ((await import('wrangler')).getPlatformProxy<{ STRATA_PROBE: string }>);
    platform = await create(options);
    assert.equal(platform.env.STRATA_PROBE, 'local-only');
    return { mode: 'local-platform-proxy', supported_api: 'getPlatformProxy', remoteBindings: false, vars_only: true, provider_binding_tested: false };
  } finally {
    try { await platform?.dispose(); }
    finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function runActivation(args: string[], factory?: LocalFactory) {
  if (args.length !== 1 || !['--plan', '--mock', '--local-proxy', '--live'].includes(args[0]))
    throw new StrataError('INVALID_ARGUMENT', 2, 'Use exactly one of --plan, --mock, --local-proxy or --live. No credentials or remote configuration are accepted.');
  if (args[0] === '--live') throw new StrataError('LIVE_ACTIVATION_BLOCKED', 7, 'Zero-overage preview billing and separate preview-session authorization are unresolved. No provider factory was loaded or called.');
  if (args[0] === '--plan') return activationPlan();
  if (args[0] === '--mock') return runMock();
  return runLocalProxy(factory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify({ ok: true, data: await runActivation(process.argv.slice(2)) })); }
  catch (error) {
    const known = error instanceof StrataError;
    console.error(JSON.stringify({ ok: false, error: { code: known ? error.code : 'LOCAL_PREPARATION_FAILED', message: known ? error.message : 'Local preparation failed; no live fallback was attempted.' } }));
    process.exitCode = known ? error.exit : 9;
  }
}
