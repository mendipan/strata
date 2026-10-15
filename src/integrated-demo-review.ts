import { digest, fail } from './model.js';
import type { OperatorPromptPacket } from './integrated-demo-operator-reply.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Expected ${label} to be an object.`);
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Expected ${label} to be non-empty text.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Expected ${label} to be a list.`);
  return value;
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function behavior(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonRecord).statement === 'string')
    return (value as JsonRecord).statement as string;
  return json(value);
}

function expected(change: JsonRecord): string {
  const prior = record(change.expected, 'change.expected');
  if (prior.kind === 'absent') return 'No prior value';
  if (prior.kind === 'value') return behavior(prior.value);
  if (prior.kind === 'fingerprint') return `Prior value with fingerprint ${text(prior.fingerprint, 'expected fingerprint')}`;
  fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Unsupported expected-value form in the canonical Layer change.');
}

function layerSource(sources: JsonRecord, ref: string): JsonRecord {
  const layer = record(sources[ref], `source for ${ref}`);
  if (`${String(layer.id)}@${String(layer.revision)}` !== ref || !Array.isArray(layer.changes) ||
      !Array.isArray(layer.requires_layers) || !Array.isArray(layer.read_set) || !Array.isArray(layer.assumptions) ||
      !Array.isArray(layer.acceptance))
    fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Layer source ${ref} does not match its exact revision or required proposal fields.`);
  return layer;
}

function acceptanceItem(block: string, id: string, criterion: unknown, label: string): string {
  const item = record(criterion, `acceptance criterion ${block}/${id}`);
  const method = text(item.method, `${block}/${id} method`);
  const check = text(item.check, `${block}/${id} check`);
  const version = text(item.version, `${block}/${id} version`);
  const fixture = text(item.fixture, `${block}/${id} fixture`);
  const subjects = array(item.subjects, `${block}/${id} subjects`).map(subject => html(text(subject, `${block}/${id} subject`)));
  return `<li class="criterion"><span class="tag ${label === 'Added' ? 'added' : 'retained'}">${html(label)}</span><strong>${html(block)} · ${html(id)}</strong><p>${html(text(item.statement, `${block}/${id} statement`))}</p><code>${html(method)} · ${html(check)}@${html(version)} · fixture ${html(fixture)}</code><small>Subjects: ${subjects.join(', ')}</small></li>`;
}

function renderChange(changeValue: unknown): string {
  const change = record(changeValue, 'Layer change');
  if (change.op !== 'set_item') fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Only canonical set_item changes can be rendered in this demo view.');
  const block = text(change.block, 'change Block');
  const path = text(change.path, 'change path');
  return `<li class="change"><div><span class="tag removed">Removed</span><strong>${html(block)} / ${html(path)}</strong><p>${html(expected(change))}</p></div><div><span class="tag added">Proposed</span><p>${html(behavior(change.value))}</p></div></li>`;
}

function dependencyList(layer: JsonRecord): string {
  const entries: string[] = [];
  for (const value of array(layer.requires_layers, 'requires_layers')) entries.push(`<li>Requires exact Layer <code>${html(text(value, 'required Layer ref'))}</code></li>`);
  for (const value of array(layer.read_set, 'read_set')) {
    const read = record(value, 'read_set entry');
    entries.push(`<li>Reads <code>${html(text(read.layer, 'read Layer ref'))}</code> (${html(text(read.mode, 'read mode'))})</li>`);
  }
  for (const value of array(layer.assumptions, 'assumptions')) {
    const assumption = record(value, 'Layer assumption');
    const prior = record(assumption.expected, 'assumption expected value');
    const valueText = prior.kind === 'value' ? behavior(prior.value) : prior.kind === 'absent' ? 'No prior value' : `Fingerprint ${text(prior.fingerprint, 'assumption fingerprint')}`;
    entries.push(`<li>Assumes <code>${html(text(assumption.block, 'assumption Block'))} / ${html(text(assumption.path, 'assumption path'))}</code>: ${html(valueText)}</li>`);
  }
  return entries.length ? `<ul class="dependencies">${entries.join('')}</ul>` : '<p class="muted">No declared Layer dependencies or assumptions.</p>';
}

function renderLayer(ref: string, layer: JsonRecord, selected: boolean): string {
  const label = selected ? 'Selected' : 'Not selected';
  const changes = array(layer.changes, `${ref} changes`).map(renderChange);
  const additions = selected ? array(layer.acceptance, `${ref} acceptance`).map(value => {
    const item = record(value, `${ref} acceptance item`);
    return acceptanceItem(text(item.block, `${ref} acceptance Block`), text(item.id, `${ref} acceptance id`), item.criterion, 'Added');
  }) : [];
  return `<article class="layer ${selected ? 'layer-selected' : 'layer-excluded'}"><div class="layer-head"><span class="tag ${selected ? 'added' : 'removed'}">${label}</span><code>${html(ref)}</code><span class="intent">${html(text(layer.intent, `${ref} intent`))}</span></div><ul class="changes">${changes.join('')}</ul><h4>Dependencies and assumptions</h4>${dependencyList(layer)}${selected && additions.length ? `<h4>Acceptance added by this Layer</h4><ul class="criteria">${additions.join('')}</ul>` : ''}</article>`;
}

export function integratedDemoSelectionReviewHtml(packet: OperatorPromptPacket): string {
  if (packet.phase !== 'selection') fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'This local behavior comparison accepts a pending selection packet only. Release endorsement uses its separate existing packet and approval flow.');
  const handoff = record(packet.decision, 'decision handoff');
  if (handoff.kind !== 'selection' || handoff.packet_digest !== packet.packet_digest || handoff.choice_preselected !== false)
    fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Selection handoff does not bind this exact packet or has a preselected choice.');
  const businessRequest = text(handoff.business_request, 'business request');
  const status = text(handoff.validation_status, 'validation status');
  const reviewed = text(handoff.reviews, 'review provenance');
  const baselineSeconds = handoff.baseline_seconds;
  if (!Number.isSafeInteger(baselineSeconds) || Number(baselineSeconds) < 1) fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Baseline behavior is missing from the selection handoff.');
  const considered = array(handoff.considered, 'considered Layer refs').map(ref => text(ref, 'considered Layer ref'));
  const packetRecord = record(handoff.packet, 'mediation packet ref');
  const mediation = record(packetRecord.packet, 'mediation decision packet');
  if (mediation.format !== 'decision-packet/1' || digest(mediation) !== packetRecord.packet_sha256 ||
      packetRecord.ref !== `decision-packet@${digest(mediation)}`)
    fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Mediation packet bytes, exact packet ref, and digest do not agree.');
  const sources = record(mediation.sources, 'mediation packet sources');
  const options = array(mediation.options, 'mediation options').map(value => record(value, 'mediation option'));
  if (!options.length || options.length > 3 || !Array.isArray(mediation.remaining_gates))
    fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Mediation options or remaining gates are outside the finite review shape.');
  const baselineRefs = new Set(considered.map(ref => text(layerSource(sources, ref).baseline, `${ref} baseline`)));
  if (baselineRefs.size !== 1) fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Considered Layers do not share one exact baseline.');
  const baselineRef = [...baselineRefs][0]!;
  const baseline = record(sources[baselineRef], `source for ${baselineRef}`);
  const blocks = record(baseline.blocks, 'baseline Blocks');
  const baselineRefText = text(baselineRef, 'baseline ref');
  const optionsMarkup: string[] = [];
  const allAffected = new Set<string>();
  const seenOptions = new Set<string>();

  for (const optionValue of options) {
    const option = optionValue;
    const id = text(option.id, 'option id');
    if (seenOptions.has(id)) fail('DEMO_REVIEW_PACKET_REFUSED', 4, 'Duplicate mediation option id.');
    seenOptions.add(id);
    const selected = array(option.selected, `${id} selected refs`).map(ref => text(ref, `${id} selected Layer ref`));
    const rejected = array(option.rejected, `${id} rejected refs`).map(ref => text(ref, `${id} rejected Layer ref`));
    const partition = [...selected, ...rejected];
    if (new Set(partition).size !== partition.length || json([...partition].sort()) !== json([...considered].sort()))
      fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Option ${id} does not partition the complete exact considered set.`);
    const layers = new Map(considered.map(ref => [ref, layerSource(sources, ref)]));
    for (const [ref, layer] of layers) {
      for (const changeValue of array(layer.changes, `${ref} changes`)) allAffected.add(text(record(changeValue, `${ref} change`).block, `${ref} change Block`));
      for (const assumptionValue of array(layer.assumptions, `${ref} assumptions`)) allAffected.add(text(record(assumptionValue, `${ref} assumption`).block, `${ref} assumption Block`));
      for (const acceptanceValue of array(layer.acceptance, `${ref} acceptance`)) allAffected.add(text(record(acceptanceValue, `${ref} acceptance`).block, `${ref} acceptance Block`));
    }
    const selectedMarkup = selected.map(ref => renderLayer(ref, layers.get(ref)!, true)).join('');
    const rejectedMarkup = rejected.map(ref => renderLayer(ref, layers.get(ref)!, false)).join('');
    const eligibility = option.executable === true ? 'Eligible for realization; behavior is not yet measured' :
      option.executable === false ? 'Not eligible for realization' : fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Option ${id} has no canonical eligibility status.`);
    const effects = text(option.effects, `${id} evaluated effects`);
    const selectedSummary = selected.map(ref => `<li><code>${html(ref)}</code></li>`).join('');
    const rejectedSummary = rejected.map(ref => `<li><code>${html(ref)}</code></li>`).join('');
    optionsMarkup.push(`<article class="option"><header class="option-head"><div><span class="eyebrow">Choice</span><h3>${html(id)} seconds</h3></div><span class="state">${html(eligibility)}</span></header><p class="effect">${html(effects)}</p><div class="partition"><section><h4>Retained in this choice</h4><ul>${selectedSummary}</ul></section><section><h4>Set aside in this choice</h4><ul>${rejectedSummary}</ul></section></div><h4>Proposed behavior by exact Layer</h4>${selectedMarkup}<h4>Competing behavior excluded by this choice</h4>${rejectedMarkup}<p class="follow-up">${html(text(option.follow_up, `${id} follow-up`))}</p></article>`);
  }

  const retainedCriteria: string[] = [];
  for (const blockId of [...allAffected].sort()) {
    const block = record(blocks[blockId], `baseline Block ${blockId}`);
    const acceptance = record(block.acceptance, `baseline Block ${blockId} acceptance`);
    for (const [id, criterion] of Object.entries(acceptance)) retainedCriteria.push(acceptanceItem(blockId, id, criterion, 'Retained'));
  }
  const noBaselineCriteria = retainedCriteria.length ? '' : '<li>No baseline acceptance criteria are attached to the affected Blocks in this packet.</li>';
  const remainingGates = array(mediation.remaining_gates, 'remaining gates').map(value => `<li>${html(text(value, 'remaining gate'))}</li>`).join('');
  const repair = handoff.repair_required_for_initial_1200 === true
    ? `<aside class="repair"><strong>1,200-second branch needs a new review.</strong> The exact 1,200 option in this packet leaves its competing reminder Layer unselected, and the displayed dependency/assumption still names the 900-second Layer. The author must revise that Layer, after which the next case revision needs its own packet and reply.</aside>`
    : '';
  const expiry = text(mediation.expires_at, 'packet expiry');
  const packetRef = text(packetRecord.ref, 'decision packet ref');
  const packetSha = text(packetRecord.packet_sha256, 'decision packet digest');
  const affectedList = [...allAffected].sort().map(id => {
    if (!blocks[id]) fail('DEMO_REVIEW_PACKET_REFUSED', 4, `Affected Block ${id} is absent from the exact baseline.`);
    return `<li><code>${html(id)}</code></li>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Booking intent review · ${html(text(mediation.case_id, 'case id'))}</title>
  <style>
    :root{color-scheme:light;--ink:#202b38;--muted:#5d6b7b;--line:#d9e0e8;--paper:#fff;--canvas:#f3f6f9;--blue:#2855a6;--blue-soft:#edf3ff;--green:#17683b;--green-soft:#edf8f0;--red:#a3393d;--red-soft:#fff1ef;--amber:#7b5600;--amber-soft:#fff7df;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}main{max-width:1120px;margin:0 auto;padding:32px 24px 56px}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(1.8rem,4vw,2.7rem);line-height:1.15;margin-bottom:10px}h2{font-size:1.35rem;margin-bottom:8px}h3{font-size:1.2rem;margin:2px 0}h4{font-size:.98rem;margin:20px 0 8px}p{margin-bottom:12px}.eyebrow,.muted,small{color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.76rem;font-weight:700}.intro,.baseline,.option,.notice,.repair,.gates{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px;margin:16px 0}.intro{padding:28px}.meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:16px;color:var(--muted);font-size:.9rem}.meta span{overflow-wrap:anywhere}.notice{border-left:5px solid var(--blue);background:var(--blue-soft)}.notice p:last-child{margin-bottom:0}.repair{border-left:5px solid var(--amber);background:var(--amber-soft)}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.option{margin:0;padding:0;overflow:hidden}.option-head{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 22px 14px}.state{background:var(--blue-soft);border-radius:999px;padding:5px 10px;font-size:.8rem;color:var(--blue);text-align:center}.effect{margin:0;padding:0 22px 18px;font-size:1.03rem}.partition{display:grid;grid-template-columns:1fr 1fr;background:#fafbfd;border-block:1px solid var(--line)}.partition section{padding:15px 22px}.partition section+section{border-left:1px solid var(--line)}.partition h4{margin:0 0 6px}.partition ul,.dependencies,.criteria,.gates ul{padding-left:20px;margin:0}.layer{padding:16px 22px;border-top:1px solid var(--line)}.layer-selected{background:var(--green-soft)}.layer-excluded{background:var(--red-soft)}.layer-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.intent{color:var(--muted)}.tag{display:inline-block;border-radius:999px;padding:2px 8px;font-size:.73rem;font-weight:750;letter-spacing:.02em}.tag.added{background:#d4efdc;color:var(--green)}.tag.removed{background:#f9d9d6;color:var(--red)}.tag.retained{background:#e7edf5;color:#45566d}.changes{list-style:none;padding:0;margin:12px 0}.change{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}.change>div{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);min-width:0}.change p{margin:7px 0 0}.dependencies li{margin:5px 0}.criterion{list-style:none;margin:10px 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}.criterion p{margin:6px 0}.criterion small{display:block;margin-top:6px}.criterion code{display:block;overflow-wrap:anywhere}.follow-up{margin:14px 22px 18px;color:var(--muted)}.gates{border-top:4px solid var(--blue)}code{font: .88em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.gates li{margin:5px 0}.footer{margin-top:22px;color:var(--muted);font-size:.85rem;overflow-wrap:anywhere}.footer p{margin:6px 0}.section-intro{color:var(--muted);max-width:800px}.baseline ul{padding-left:0}.affected{padding-left:20px}.affected li{margin:5px 0}
    @media(max-width:760px){main{padding:16px 12px 36px}.columns{grid-template-columns:1fr}.change{grid-template-columns:1fr}.option-head{align-items:flex-start;flex-direction:column}.partition section{padding:13px}.intro,.baseline,.notice,.repair,.gates{padding:18px}}
  </style>
</head>
<body><main>
  <section class="intro"><div class="eyebrow">Strata · local integrated demo · selection review</div><h1>Booking hold intent</h1><p>${html(businessRequest)}</p><div class="meta"><span>Case <code>${html(text(mediation.case_id, 'case id'))} · revision ${html(mediation.case_revision)}</code></span><span>Baseline hold <code>${html(baselineSeconds)} seconds</code></span><span>Expires <code>${html(expiry)}</code></span><span>No choice preselected</span></div><div class="meta"><span>Validation status: <strong>${html(status)}</strong></span></div></section>
  <aside class="notice"><strong>Read-only review. No selection or Release approval is created here.</strong><p>The rendered comparison uses this exact packet and its Layer sources. To submit a choice, use the existing operator reply flow with packet digest <code>${html(packet.packet_digest)}</code>. A changed proposal needs a new case revision, packet, and reply. A selection does not grant Release approval. The local reply label does not authenticate identity or consent.</p><p>${html(reviewed)}</p></aside>
  <section class="baseline"><h2>Retained baseline acceptance</h2><p class="section-intro">Existing acceptance criteria on the affected Blocks remain in force for each option. These are required checks, not passing evidence.</p><ul class="criteria">${retainedCriteria.join('') || noBaselineCriteria}</ul><h3>Affected Blocks</h3><ul class="affected">${affectedList}</ul></section>
  ${repair}
  <section><h2>Competing intent options</h2><p class="section-intro">“Selected” and “set aside” preserve the mediation packet’s exact whole-Layer partition. Each change shows the value it replaces and the proposed value from that Layer revision.</p><div class="columns">${optionsMarkup.join('')}</div></section>
  <section class="gates"><h2>What remains before Release</h2><p>Option eligibility is a mediation result; it does not mean the behavior has been measured. The pending handoff says validation is <strong>${html(status)}</strong>. The packet still requires:</p><ul>${remainingGates}</ul><p>Later scope/guardian and Release approvals remain separate from the selection decision.</p></section>
  <footer class="footer"><p>Run <code>${html(packet.run_id)}</code> · Workflow handoff SHA-256 <code>${html(packet.packet_digest)}</code></p><p>Mediation packet <code>${html(packetRef)}</code> · SHA-256 <code>${html(packetSha)}</code></p><p>Baseline and proposal bytes shown here come from this packet’s source set. No model-authored summary or generated app output is used as proposal data.</p></footer>
</main></body></html>
`;
}
