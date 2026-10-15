import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { BLOCK_MODEL, bytesDigest, canonical, digest, fail } from '../src/model.js';
import { assertQuiesced, noLinks } from '../src/node-state.js';
import { prepareChecklist, verifyChecklistHandoff, verifyPrepared, CHECKLIST_CEILINGS, type ChecklistHandoff, type PreparedChecklist } from '../src/checklist-cloud-contract.js';
import { checklistToolExecutionFiles } from './checklist-cloud-source.js';
import { checklistProfileSource } from './checklist-cloud-profile-source.js';
import {CHECKLIST_VERSION_JSON_BYTES} from './checklist-cloud-worker-version.js';
import { checklistPrivateConfigs, checklistConfigDigest } from '../src/checklist-cloud-config.js';

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function boundedFile(file: string, maximum: number) {
  await noLinks(file); if ((await stat(file)).size > maximum) fail('CHECKLIST_INPUT_REFUSED', 6, 'Input file exceeds fixed bound.');
  const bytes = await readFile(file); if (bytes.length > maximum) fail('CHECKLIST_INPUT_REFUSED', 6, 'Input changed beyond fixed bound.'); return new Uint8Array(bytes);
}
export type ProducerPins = { lane_id: string; summary_sha256: string; registry_sha256: string; manifest_sha256: string };
export type ChecklistProducerSnapshot = { lane: string; descriptor_file: string; state_directory: string; summary_file: string; manifest_file: string;
  source_commit: string; project_id: string; release_ref: string; baseline_ref: string; realization_ref: string; target_ref: string;
  output_tree: string; release_record: unknown; baseline_record: unknown; collision_ref: string;
  considered: string[]; selected: string[]; rejected: string[]; resolution_ref: string; required_refs: string[] };
// Product port accepts an explicit snapshot packet. Application-specific producer mapping lives externally.
// Never opens accounts/policy/sessions/config or private drafts.
export async function consumeChecklistSnapshot(snapshot: ChecklistProducerSnapshot, expected: ProducerPins, allowSynthetic = false): Promise<ChecklistHandoff> {
  const lane = await noLinks(snapshot.lane);
  for (const file of [snapshot.descriptor_file,snapshot.state_directory,snapshot.summary_file,snapshot.manifest_file]) {
    const relative = path.relative(lane, path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('CHECKLIST_INPUT_REFUSED', 6, 'Producer paths must be explicit and inside its isolated lane.');
  }
  const state = snapshot.state_directory; await assertQuiesced(state);
  const laneDescriptor = JSON.parse(decode(await boundedFile(snapshot.descriptor_file, 65536)));
  if (laneDescriptor.lane_id !== expected.lane_id || laneDescriptor.project_id !== snapshot.project_id || laneDescriptor.model_version !== BLOCK_MODEL) fail('CHECKLIST_INPUT_REFUSED', 6, 'Exact checklist lane descriptor required.');
  const summaryBytes = await boundedFile(snapshot.summary_file, CHECKLIST_CEILINGS.json_bytes);
  const registryFile = path.join(state, 'registry.json'), registryBytes = await boundedFile(registryFile, 8 * 1024 * 1024);
  if (bytesDigest(summaryBytes) !== expected.summary_sha256 || bytesDigest(registryBytes) !== expected.registry_sha256) fail('CHECKLIST_INPUT_REFUSED', 6, 'Trusted producer summary/registry pins changed.');
  const registry = JSON.parse(decode(registryBytes));
  const manifestPath = await noLinks(snapshot.manifest_file);
  const manifestBytes = await boundedFile(manifestPath, CHECKLIST_CEILINGS.json_bytes);
  if (bytesDigest(manifestBytes) !== expected.manifest_sha256) fail('CHECKLIST_INPUT_REFUSED', 6, 'Trusted selected manifest bytes changed.');
  const manifest = JSON.parse(decode(manifestBytes)), records: ChecklistHandoff['records'] = {}, record_hashes: Record<string, string> = {};
  const published = Object.entries(registry.entries ?? {}).filter(([, e]) => (e as { published?: boolean }).published === true);
  if (published.length > CHECKLIST_CEILINGS.records) fail('CHECKLIST_INPUT_REFUSED', 6, 'Full published history exceeds 80 records; do not drop history to fit.');
  let total = 0;
  for (const [ref, raw] of published) {
    const entry = raw as { hash: string; type: string; published: true };
    if (!/^[a-f0-9]{64}$/.test(entry.hash) || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/.test(ref) || typeof entry.type !== 'string') fail('CHECKLIST_INPUT_REFUSED', 6, 'Malformed registry entry.');
    const bytes = await boundedFile(path.join(state, 'artifacts', entry.hash + '.json'), CHECKLIST_CEILINGS.json_bytes);
    total += bytes.length; if (total > CHECKLIST_CEILINGS.json_bytes) fail('CHECKLIST_INPUT_REFUSED', 6, 'Published JSON exceeds fixed bound.');
    const data = JSON.parse(decode(bytes));
    if (bytesDigest(bytes) !== entry.hash || canonical(data) !== decode(bytes)) fail('CHECKLIST_INPUT_REFUSED', 6, 'Published blob is missing, changed or noncanonical.');
    records[ref] = { type: entry.type, published: true, data }; record_hashes[ref] = entry.hash;
  }
  if (canonical(records[snapshot.release_ref]?.data) !== canonical(snapshot.release_record) || canonical(records[snapshot.baseline_ref]?.data) !== canonical(snapshot.baseline_record) ||
    records[snapshot.baseline_ref]?.data.format !== 'release/3' || records[snapshot.baseline_ref]?.data.state !== 'validated' ||
    snapshot.realization_ref !== manifest.realization_ref || canonical(records[manifest.realization_ref]?.data) !== canonical(manifest.record) ||
    snapshot.output_tree !== manifest.record.output_tree || snapshot.target_ref !== manifest.record.target) fail('CHECKLIST_INPUT_REFUSED', 6, 'Summary/registry/selected realization pins differ; unvalidated baseline refused.');
  const candidate = records[snapshot.target_ref]?.data, blocked = records[snapshot.collision_ref]?.data;
  if (snapshot.considered.length !== 3 || snapshot.selected.length !== 2 || snapshot.rejected.length !== 1 ||
    canonical([...snapshot.selected, ...snapshot.rejected].sort()) !== canonical([...snapshot.considered].sort()) ||
    canonical(candidate?.proposals) !== canonical([...snapshot.considered].sort()) || canonical(candidate?.selected) !== canonical([...snapshot.selected].sort()) ||
    canonical(blocked?.proposals) !== canonical([...snapshot.considered].sort()) || !(candidate.resolutions as string[]).includes(snapshot.resolution_ref)) fail('CHECKLIST_INPUT_REFUSED', 6, 'Complete considered decision history required.');
  for (const ref of snapshot.required_refs) if (!records[ref]?.published) fail('CHECKLIST_INPUT_REFUSED', 6, 'Missing exact published mediation handoff record.');
  for (const name of ['collection.mjs', 'README.md']) {
    const bytes = await boundedFile(path.join(path.dirname(manifestPath), name), CHECKLIST_CEILINGS.json_bytes);
    if (bytesDigest(bytes) !== bytesDigest(manifest.record.files[name])) fail('CHECKLIST_INPUT_REFUSED', 6, 'Selected generated files differ from realization.');
  }
  // Recheck the frozen snapshot after the read; no lease creation or mutation of producer files.
  await assertQuiesced(state);
  if (bytesDigest(await boundedFile(registryFile, 8 * 1024 * 1024)) !== bytesDigest(registryBytes)) fail('CHECKLIST_INPUT_REFUSED', 6, 'Producer registry changed during snapshot.');
  const input: ChecklistHandoff = { format: 'strata-checklist-cloud-handoff/1', evidence_kind: allowSynthetic ? 'synthetic-test-only' : 'published-local-history', source_commit: snapshot.source_commit,
    project_id: laneDescriptor.project_id, release_ref: snapshot.release_ref, realization_ref: manifest.realization_ref, records, record_hashes,
    module_sha256: bytesDigest(manifest.record.files['collection.mjs']), output_tree: manifest.record.output_tree, producer: expected,
    expectations: { capacity: 7, visible_audit_events: 10, unicode_observer_audit_events: 11 } };
  verifyChecklistHandoff(input, allowSynthetic); return input;
}

export type ChecklistBundleManifest = { format: 'strata-checklist-cloud-source/1'; live_authorized: false; preparation_sha256: string;
  purpose?:'app-model-diagnostic'|'worker-version-diagnostic';
  inputs: { path: string; sha256: string; size_bytes: number }[]; outputs: { path: string; sha256: string; size_bytes: number }[];
  static_import: { importer: 'app-entry.mjs'; imported: 'collection.mjs'; module_sha256: string }; source_sha256: string };
export async function verifyChecklistBundle(output: string, repository: string, expectedSource: string, p: PreparedChecklist) {
  const source = JSON.parse(decode(await boundedFile(path.join(output,'source-manifest.json'), 2 * 1024 * 1024))) as ChecklistBundleManifest;
  const {source_sha256,...frozen}=source;
  if (source.format !== 'strata-checklist-cloud-source/1' || source.live_authorized !== false || digest(frozen) !== source_sha256 || source_sha256 !== expectedSource || source.preparation_sha256 !== digest(p) || source.static_import.module_sha256 !== p.pins.module_sha256) fail('CHECKLIST_SOURCE_REFUSED', 6, 'Reviewed frozen source manifest differs.');
  for (const entry of source.inputs) {
    const bytes = await readFile(path.resolve(repository,entry.path));
    if (bytes.length !== entry.size_bytes || bytesDigest(bytes) !== entry.sha256) fail('CHECKLIST_SOURCE_REFUSED',6,'Transitive source/compiled/dependency input changed.');
  }
  for (const entry of source.outputs) {
    if (!['app-bundle.mjs','workflow-bundle.mjs','app-metafile.json','workflow-metafile.json','profile-source-identity.json'].includes(entry.path)) fail('CHECKLIST_SOURCE_REFUSED',6,'Unexpected build output.');
    const bytes = await boundedFile(path.join(output,entry.path),8 * 1024 * 1024);
    if (bytes.length !== entry.size_bytes || bytesDigest(bytes) !== entry.sha256) fail('CHECKLIST_SOURCE_REFUSED',6,'Reviewed deployment bundle changed.');
  }
  if(canonical(source.outputs.map(e=>e.path).sort())!==canonical(['app-bundle.mjs','workflow-bundle.mjs','app-metafile.json','workflow-metafile.json','profile-source-identity.json'].sort()))fail('CHECKLIST_SOURCE_REFUSED',6,'Complete source identity/output inventory required.');
  const identity=JSON.parse(decode(await boundedFile(path.join(output,'profile-source-identity.json'),131072)));
  const realization=p.input.records[p.input.realization_ref].data;
  if(identity.format!=='strata-checklist-profile-source/1'||identity.profile_id!=='collection-host/1'||digest(identity.archive)!==identity.profile_sha256||
    identity.profile_sha256!==realization.profile||identity.checker_sha256!==realization.checker_sha256)fail('CHECKLIST_SOURCE_REFUSED',6,'Original Node profile/checker archive identity differs.');
  return source;
}
// External-only generated module/config/source inventory. esbuild is local; no Wrangler/provider process is launched.
export async function buildChecklistBundle(p: PreparedChecklist, output: string, repository: string, allowSynthetic = false,purpose:'full-demo'|'app-model-diagnostic'|'worker-version-diagnostic'='full-demo') {
  if(purpose!=='full-demo'&&purpose!=='app-model-diagnostic'&&purpose!=='worker-version-diagnostic')fail('INVALID_ARGUMENT',2,'Unknown checklist package purpose.');
  const diagnostic=purpose==='app-model-diagnostic',versionDiagnostic=purpose==='worker-version-diagnostic',evidenceOnly=diagnostic||versionDiagnostic;
  verifyPrepared(p, allowSynthetic); repository = path.resolve(repository); output = await noLinks(output);
  if (!path.relative(repository, output).startsWith('..') || output === repository) fail('CHECKLIST_OUTPUT_REFUSED', 5, 'Generated app/evidence must be outside the tracked product repo.');
  let ancestor = output;
  while (path.dirname(ancestor) !== ancestor) {
    try { await stat(path.join(ancestor, '.git')); fail('CHECKLIST_OUTPUT_REFUSED', 5, 'Generated app package cannot live inside a Git checkout.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } ancestor = path.dirname(ancestor);
  }
  try { if ((await readdir(output)).length) fail('CHECKLIST_OUTPUT_REFUSED', 5, 'Occupied output refused.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await mkdir(output, { recursive: true });
  const realization = verifyChecklistHandoff(p.input, allowSynthetic).realization;
  const profileSource=checklistProfileSource(repository);
  if(profileSource.identity.profile_sha256!==realization.profile||profileSource.identity.checker_sha256!==realization.checker_sha256)fail('CHECKLIST_PROFILE_SOURCE_REFUSED',6,'The exact intended Node profile/checker identity is required.');
  await writeFile(path.join(output,'profile-source-identity.json'),canonical(profileSource.identity));
  await writeFile(path.join(output, 'collection.mjs'), realization.files['collection.mjs']);
  await writeFile(path.join(output, 'preparation.json'), canonical(p));
  const rel = (file: string) => { let value = path.relative(output, path.join(repository, 'dist/src', file)).replaceAll('\\', '/'); if (!value.startsWith('.')) value = './' + value; return value; };
  await writeFile(path.join(output, 'app-entry.mjs'), `import { createCollection } from './collection.mjs';\nimport { checklistAppWorker } from ${JSON.stringify(rel('checklist-cloud-app-worker.js'))};\nexport default checklistAppWorker(createCollection, ${canonical(p.pins)});\n`);
  await writeFile(path.join(output, 'workflow-entry.mjs'), `import { WorkflowEntrypoint } from 'cloudflare:workers';\nimport { runChecklistCloudWorkflow, checklistWorkflowEvent } from ${JSON.stringify(rel('checklist-cloud-workflow.js'))};\nimport preparation from './preparation.json';\nexport class ChecklistArchiveWorkflow extends WorkflowEntrypoint {\n async run(rawEvent, step) {\n  const event = checklistWorkflowEvent(rawEvent);\n  const grant = event.payload.grant;\n  return runChecklistCloudWorkflow(preparation, grant, { source_sha256: this.env.CHECKLIST_SOURCE_SHA256, grant_sha256: event.payload.grant_sha256, authorization_sha256: this.env.CHECKLIST_AUTHORIZATION_SHA256, workflow_version_id: this.env.CHECKLIST_VERSION.id, app_version_id: grant.app_version_id }, event, step, { namespace: this.env.ARTIFACTS, transport: request => fetch(request), app: this.env.CHECKLIST_APP, now: Date.now, mode: 'remote' });\n }\n}\n`);
  const graphInputs = new Set<string>();
  for (const name of ['app','workflow']) {
    const result = await build({ entryPoints: [path.join(output, name + '-entry.mjs')], outfile: path.join(output, name + '-bundle.mjs'),
      bundle: true, write: true, metafile: true, platform: 'neutral', target: 'es2022', format: 'esm', external: ['node:*','cloudflare:workers'], logLevel: 'silent',
      absWorkingDir: repository, nodePaths: [path.join(repository, 'node_modules')],plugins:name==='workflow'?[profileSource.plugin]:[] });
    await writeFile(path.join(output, name + '-metafile.json'), canonical(result.metafile));
    for (const file of Object.keys(result.metafile!.inputs)) graphInputs.add(path.resolve(repository, file));
    if (name === 'app') {
      const importer = result.metafile!.inputs[path.relative(repository, path.join(output, 'app-entry.mjs')).replaceAll('\\','/')];
      if (!importer?.imports.some(i => path.resolve(repository, i.path) === path.join(output, 'collection.mjs'))) fail('CHECKLIST_BUILD_REFUSED', 6, 'Compiled static module import edge is absent.');
      if (Object.keys(result.metafile!.inputs).some(f => /(?:^|\/)dist\/src\/(?:profiles\/|core\.js|artifacts)/.test(f))) fail('CHECKLIST_BUILD_REFUSED', 6, 'App bundle imported semantics/checker/archive infrastructure.');
    }
  }
  // Follow BOTH host execution import graphs. This includes node-state and its link/quiescence safeguards.
  for(const entry of ['dist/scripts/checklist-cloud-prepare.js','dist/scripts/checklist-cloud-run.js','dist/scripts/checklist-cloud-bootstrap.js']){
    const graph=await build({entryPoints:[path.join(repository,entry)],bundle:true,write:false,metafile:true,platform:'node',format:'esm',packages:'external',
      absWorkingDir:repository,nodePaths:[path.join(repository,'node_modules')],logLevel:'silent'});
    for(const file of Object.keys(graph.metafile!.inputs))graphInputs.add(path.resolve(repository,file));
  }
  for (const file of [...graphInputs]) {
    const relative = path.relative(path.join(repository, 'dist'), file);
    if (!relative.startsWith('..') && relative.endsWith('.js')) graphInputs.add(path.join(repository, relative.slice(0, -3) + '.ts'));
  }
  for (const file of ['package.json','package-lock.json','tsconfig.json','LICENSE','NOTICE']) graphInputs.add(path.join(repository, file));
  // The attended host/preparer are reviewed execution sources too, even though they are not Worker imports.
  for(const file of ['scripts/checklist-cloud-prepare.ts','scripts/checklist-cloud-run.ts','dist/scripts/checklist-cloud-prepare.js','dist/scripts/checklist-cloud-run.js',
    'node_modules/esbuild/package.json','node_modules/esbuild/lib/main.js','node_modules/typescript/package.json','node_modules/wrangler/package.json',
    'node_modules/wrangler/config-schema.json','node_modules/cf/package.json','node_modules/@cloudflare/workers-types/package.json'])graphInputs.add(path.join(repository,file));
  const tools=await checklistToolExecutionFiles(repository);
  for(const file of tools.files)graphInputs.add(file);
  const inputs = [];
  for (const file of [...graphInputs].sort()) { const bytes = await readFile(file); inputs.push({ path: path.relative(repository, file).replaceAll('\\','/'), sha256: bytesDigest(bytes), size_bytes: bytes.length }); }
  const outputs = [];
  for (const file of ['app-bundle.mjs','workflow-bundle.mjs','app-metafile.json','workflow-metafile.json','profile-source-identity.json']) { const bytes = await readFile(path.join(output, file)); outputs.push({ path: file, sha256: bytesDigest(bytes), size_bytes: bytes.length }); }
  const frozen = { format: 'strata-checklist-cloud-source/1' as const, live_authorized: false as const,...(purpose!=='full-demo'?{purpose}:{}),preparation_sha256: digest(p), inputs, outputs,
    static_import: { importer: 'app-entry.mjs' as const, imported: 'collection.mjs' as const, module_sha256: p.pins.module_sha256 } };
  const source: ChecklistBundleManifest = { ...frozen, source_sha256: digest(frozen) };
  if(new TextEncoder().encode(canonical(source)).length>2*1024*1024)fail('CHECKLIST_SOURCE_REFUSED',6,'Complete source/tool manifest exceeds its existing verification bound; no silent widening.');
  const deploymentBundleBytes=outputs.filter(o=>o.path.endsWith('-bundle.mjs')).reduce((n,o)=>n+o.size_bytes,0);
  const versionWireSizes=outputs.filter(o=>o.path.endsWith('-bundle.mjs')).map(o=>4*Math.ceil(o.size_bytes/3)+65536);
  if(versionWireSizes.some(size=>size>CHECKLIST_VERSION_JSON_BYTES))fail('CHECKLIST_BUILD_REFUSED',6,'Base64 upload/module readback exceeds the reviewed 2 MiB version JSON envelope.');
  const conservativeTransfer=p.qualification.reservations.bytes + p.qualification.management.maximum_calls * (CHECKLIST_CEILINGS.request_bytes+CHECKLIST_CEILINGS.response_bytes) +
    versionWireSizes.reduce((sum,size)=>sum+size,0) + 4*CHECKLIST_VERSION_JSON_BYTES +
    24*(8192+CHECKLIST_CEILINGS.response_bytes) + 2*CHECKLIST_CEILINGS.app_response_bytes;
  if(conservativeTransfer>CHECKLIST_CEILINGS.transfer_bytes)fail('CHECKLIST_BUILD_REFUSED',6,'Compiled package plus run/management transfer does not fit; no automatic widening.');
  await writeFile(path.join(output, 'source-manifest.json'), canonical(source));
  const {app:appConfig,workflow:workflowConfig}=checklistPrivateConfigs(p,source.source_sha256);
  for (const [file, value] of [['wrangler.app.jsonc', appConfig], ['wrangler.workflow.jsonc', workflowConfig]] as const) await writeFile(path.join(output, file), canonical(value));
  const approval = { format: 'strata-checklist-cloud-approval-package/1', live_authorized: false, source_sha256: source.source_sha256,
    purpose,diagnostic_only:evidenceOnly,billing_state:evidenceOnly?'unresolved':null,
    diagnostic_request_limits:diagnostic?{work_calls:13,cleanup_calls:2,retries:0,app_requests:0}:versionDiagnostic?{work_calls:17,cleanup_calls:0,retries:0,app_requests:0}:null,
    preparation_sha256: digest(p), input_sha256: p.input_sha256, target: p.target, target_sha256: p.target_sha256, pins: p.pins,
    configs: { app_sha256: digest(appConfig), workflow_sha256: digest(workflowConfig) }, config_sha256:checklistConfigDigest(p,source.source_sha256),qualification: p.qualification,
    private_resources: diagnostic?{workers:1,workflow:0,instance:0,repository:0,service_bindings:0,public_routes:0}:versionDiagnostic?{workers:2,workflow:0,instance:0,repository:0,service_bindings:1,public_routes:0}:{ workers: 2, workflow: 1, instance: 1, repository: 1, service_bindings: 1, public_routes: 0 },
    build_qualification:{deployment_bundle_bytes:deploymentBundleBytes,bootstrap_version_json_bytes:CHECKLIST_VERSION_JSON_BYTES,conservative_transfer_bytes:conservativeTransfer,
      frozen_tool_packages:tools.package_count,frozen_tool_files:tools.file_count,management_provider_requests_per_reservation:1,management_automatic_retries:0,management_pagination:'refuse',
      workflow_subrequests:p.qualification.workflow_subrequests,workflow_subrequests_limit:workflowConfig.limits.subrequests},
    required_owner_decisions: versionDiagnostic?['Exact source/config/module and fresh unused names; existing access only; US$1 gross reservation',
      'Up to 17 exchanges with no retries; stop after the second Worker version comparison',
      'Retain both private Workers even on failure; no DELETE, Workflow definition, instance, archive writes, app invocation or runtime grant',
      'Keep consumed permission and the full hold; unresolved setup blocks same-target retry']:diagnostic?['Exact diagnostic source/config/module and fresh unused target names','Existing credential reference, readiness attestations and unchanged gross spending caps',
      'One app Worker/version; capture public model observations; no retries or app invocation','Stop before any second Worker, Workflow, tokens, instance or run grant; billing remains unresolved',
      'Use existing acknowledged-ID cleanup; keep unqualified absence, holds and consumed activation'] : ['Exact reviewed source/config/module and unused target names', 'Protected existing credential reference and bounded readiness reads',
      'Eligibility/metered charges and positive numeric USD spending boundary', 'Returned two deployed version IDs and new frozen grant/config hashes',
      'One consumed instance/run/repository; no retry/restart', 'Delete exact instance; retain/delete exact repository and two Workers/Workflow; preserve readback first'],
    limits: CHECKLIST_CEILINGS, runtime_grant_created: false, credential_read: false, deployed: false, location_claim: p.location_claim };
  await writeFile(path.join(output, 'approval-package.json'), canonical(approval));
  return { output, source, approval };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Explicit local inputs only. No auto-enumeration of an account, credential or producer lane.
  const [snapshotFile, pinsFile, targetFile, output, repository,mode,...extra] = process.argv.slice(2);
  if(extra.length||(mode!==undefined&&mode!=='--app-model-diagnostic'&&mode!=='--worker-version-diagnostic'))fail('INVALID_ARGUMENT',2,'Only explicit --app-model-diagnostic or --worker-version-diagnostic preparation flags are supported.');
  if (![snapshotFile,pinsFile,targetFile,output,repository].every(Boolean)) fail('INVALID_ARGUMENT', 2, 'Usage: checklist-cloud-prepare SNAPSHOT_JSON PRODUCER_PINS_JSON TARGET_JSON NEW_EXTERNAL_OUTPUT REPOSITORY');
  const pins = JSON.parse(decode(await boundedFile(pinsFile, 65536)));
  const input = await consumeChecklistSnapshot(JSON.parse(decode(await boundedFile(snapshotFile, CHECKLIST_CEILINGS.json_bytes))), pins), target = JSON.parse(decode(await boundedFile(targetFile, 65536)));
  const p = prepareChecklist(input, target, digest(input));
  const purpose=mode==='--app-model-diagnostic'?'app-model-diagnostic':mode==='--worker-version-diagnostic'?'worker-version-diagnostic':'full-demo',result = await buildChecklistBundle(p, output, repository,false,purpose);
  console.log(canonical({ prepared: true, live_authorized: false,purpose,diagnostic_only:purpose!=='full-demo', output: result.output, source_sha256: result.source.source_sha256, input_sha256: p.input_sha256 }));
}
