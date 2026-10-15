// UI input checks for a portable Layer proposal. The authenticated Strata
// layer.create workflow still performs authoritative normalization/validation.
const idPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export function draftText(value, label, contentModel = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (new TextEncoder().encode(value).length > 4096) throw new Error(`${label} must fit within 4096 UTF-8 bytes.`);
  if (contentModel && /[`]|<[A-Za-z/!]|(?:javascript|data|vbscript):|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/i.test(value)) throw new Error(`${label} must be plain text without markup, code or script URLs.`);
  return value.trim();
}
export function draftChange(release, { block: id, path, value }) {
  const block = release.blocks[id];
  if (!block) throw new Error('Choose an existing Block from this baseline.');
  let before;
  if (path === 'purpose') before = block.purpose;
  else if (/^requirements\.[A-Za-z0-9_-]+$/.test(path)) before = block.requirements[path.slice(13)];
  else throw new Error('Choose a supported purpose or requirement item.');
  if (JSON.stringify(before) === JSON.stringify(value)) throw new Error('Change the item before adding it to the draft.');
  return { op: 'set_item', block: id, path, expected: before === undefined ? { kind: 'absent' } : { kind: 'value', value: structuredClone(before) }, value: structuredClone(value) };
}
export function makeLayerDraft(release, { id, owner, intent, changes, acceptance = [] }) {
  if (!idPattern.test(id) || id.length > 128) throw new Error('Use a Layer ID with letters, numbers, dots, underscores or hyphens (up to 128 characters).');
  const content = release.model_version !== 'strata/0.1-facets-experimental';
  const seen = new Set();
  if (!changes.length || changes.length > 25) throw new Error('A draft needs 1–25 proposed items.');
  for (const change of changes) {
    const key = change.block + '/' + change.path;
    if (seen.has(key)) throw new Error('Each item may be proposed only once in this draft.');
    seen.add(key);
    const current = draftChange(release, change);
    if (JSON.stringify(current.expected) !== JSON.stringify(change.expected)) throw new Error('The baseline item changed. Reopen this proposal from the current Release.');
    if (typeof change.value === 'string') draftText(change.value, 'Purpose', content);
    else {
      draftText(change.value.statement, 'Requirement statement', content);
      if (!['rule', 'invariant'].includes(change.value.kind)) throw new Error('Choose a rule or invariant.');
      if (!change.value.facets.length || change.value.facets.some(f => !['behavior', 'design', 'data', 'safety'].includes(f))) throw new Error('Choose at least one supported facet.');
      if (content && !change.value.acceptance.length) throw new Error('Link at least one acceptance criterion.');
      for (const key of change.value.acceptance) if (!Object.hasOwn(release.blocks[change.block].acceptance, key) && !acceptance.some(a => a.block === change.block && a.id === key)) throw new Error('An acceptance criterion is absent from this draft and baseline.');
    }
  }
  for (const a of acceptance) {
    const key = a.block + '/acceptance.' + a.id;
    if (!/^[A-Za-z0-9_-]+$/.test(a.id) || Object.hasOwn(release.blocks[a.block]?.acceptance ?? {}, a.id) || seen.has(key)) throw new Error('New acceptance needs a unique key on its Block.');
    seen.add(key);
    for (const field of ['statement', 'check', 'version', 'fixture']) draftText(a.criterion[field], 'Acceptance ' + field, content);
    if (!idPattern.test(a.criterion.check)) throw new Error('Acceptance check must be a valid check ID.');
    if (!['review', 'mechanical'].includes(a.criterion.method)) throw new Error('Choose an acceptance method.');
  }
  return { ...(release.model_version==='strata/0.3-block-lifecycle-experimental'?{created_blocks:[]}:{}), id, revision: 1, owner: draftText(owner, 'Requested Layer owner'), model_version: release.model_version, baseline: release.ref, intent: draftText(intent, 'Proposal intent', content), changes: structuredClone(changes), requires_layers: [], read_set: [], assumptions: [], acceptance: structuredClone(acceptance), resolution_proposals: [], derived_from: null };
}

// Portable supplied-content handoff, not a grant or a server-side private-draft lookup.
export const AUTHORING_HANDOFF = 'strata-authoring-handoff/1';
const contentModels = ['strata/0.2-content-mediation-experimental', 'strata/0.3-block-lifecycle-experimental'];
export function normalizedDraft(record) {
  const draft = structuredClone(record);
  for (const key of ['ref', 'type', 'published', 'review_required', 'proposed_requirement_facets', 'proposals']) delete draft[key];
  return draft;
}
function boundedJson(value, depth = 0, count = { n: 0 }) {
  if (++count.n > 20000 || depth > 32) throw new Error('The handoff exceeds the bounded content limit.');
  if (Array.isArray(value)) { for (const item of value) boundedJson(item, depth + 1, count); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('The handoff contains an unsupported field.');
      boundedJson(item, depth + 1, count);
    }
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) throw new Error('The handoff must contain JSON values.');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  if (value === undefined) throw new Error('Undefined is not a model value.');
  return JSON.stringify(value);
}
// Same canonical JSON and UTF-8 SHA-256 used by src/model.ts. Hash the complete
// immutable record, including server-authored pins, before confirming a save.
export async function canonicalDigest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function inspectAuthoringHandoff(text, project, model) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 800000) throw new Error('The handoff must fit within 800000 UTF-8 bytes.');
  let packet; try { packet = JSON.parse(text); } catch { throw new Error('Paste a valid JSON authoring handoff.'); }
  boundedJson(packet);
  if (!packet || Array.isArray(packet) || Object.keys(packet).sort().join(',') !== 'draft,draft_digest,draft_ref,format,model_version,project_id' || packet.format !== AUTHORING_HANDOFF) throw new Error('Use an exact strata-authoring-handoff/1 packet exported from Studio.');
  if (!contentModels.includes(model) || packet.model_version !== model || packet.project_id !== project) throw new Error('This handoff belongs to another project or model. Open its configured project first.');
  const draft = packet.draft;
  if (!draft || !idPattern.test(draft.id) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || packet.draft_ref !== `${draft.id}@${draft.revision}` || draft.model_version !== model || typeof draft.owner !== 'string' || typeof draft.baseline !== 'string' || typeof draft.intent !== 'string' || !Array.isArray(draft.changes) || !Array.isArray(draft.acceptance) || (model === contentModels[1] && !Array.isArray(draft.created_blocks)) || !/^[a-f0-9]{64}$/.test(packet.draft_digest)) throw new Error('The exact draft reference, digest or required Layer fields are invalid.');
  const actual = await canonicalDigest(draft);
  if (actual !== packet.draft_digest) throw new Error('The supplied content does not match the draft digest. Ask the author to export it again.');
  return packet;
}
export function authoringHandoff(project, draft, digest) {
  return { format: AUTHORING_HANDOFF, project_id: project, model_version: draft.model_version, draft_ref: `${draft.id}@${draft.revision}`, draft_digest: digest, draft: structuredClone(draft) };
}

// Edits only one requirement on a Block proposed by this exact owned Layer.
// Server preview/revise remains authoritative for normalization, ownership and head.
export function typedBlockRequirement(draft, blockId, input) {
  if(draft.model_version!=='strata/0.3-block-lifecycle-experimental'||!Array.isArray(draft.created_blocks)) throw new Error('Typed draft-Block requirements require the existing v0.3 Block contract.');
  const block=draft.created_blocks.find(b=>b.id===blockId);
  if(!block) throw new Error('Choose a new Block from this exact saved Layer.');
  const key=input.key.trim();
  if(!/^[A-Za-z0-9_-]+$/.test(key)||key.length>128||['__proto__','constructor','prototype'].includes(key)) throw new Error('Requirement keys use up to 128 letters, numbers, underscores or hyphens.');
  if(input.add && Object.hasOwn(block.requirements,key)) throw new Error('That requirement already exists. Select it to edit it.');
  if(!input.add && !Object.hasOwn(block.requirements,key)) throw new Error('Select an existing requirement or choose Add a requirement.');
  if(!['rule','invariant'].includes(input.kind)) throw new Error('Choose Rule for a requirement on a new Block.');
  if(input.kind==='invariant') throw new Error('Invariants on new Blocks require explicit guardian assignment support; the current creation operation cannot author them.');
  const facets=[...input.facets];
  if(!facets.length||new Set(facets).size!==facets.length||facets.some(f=>!['behavior','design','data','safety'].includes(f))) throw new Error('Choose at least one supported facet.');
  const acceptance=[...input.acceptance];
  if(!acceptance.length||new Set(acceptance).size!==acceptance.length||acceptance.some(id=>!Object.hasOwn(block.acceptance,id))) throw new Error('Link at least one existing acceptance criterion on this Block.');
  facets.sort();acceptance.sort();
  if(input.parameters.length>32) throw new Error('This form supports up to 32 parameters; retain advanced JSON for larger existing records.');
  const parameters={};
  for(const row of input.parameters){
    const name=row.name;
    if(!name.trim()||new TextEncoder().encode(name).length>128||['__proto__','constructor','prototype'].includes(name.trim())) throw new Error('Each parameter needs a safe, unique name within 128 UTF-8 bytes.');
    if(Object.hasOwn(parameters,name)) throw new Error('Parameter names must be unique.');
    if(row.type==='number'){
      if(typeof row.value!=='string'||!row.value.trim()||!Number.isFinite(Number(row.value))) throw new Error('Parameter '+name+' needs a finite number.');
      parameters[name]=Number(row.value);
    }else if(row.type==='boolean'&&typeof row.value==='boolean')parameters[name]=row.value;
    else throw new Error('Parameters support only finite numbers and booleans in this model.');
  }
  const value={statement:draftText(input.statement,'Requirement statement',true),kind:input.kind,facets,acceptance,parameters};
  if(!input.add&&canonicalJson(value)===canonicalJson(block.requirements[key])) throw new Error('Change the requirement before reviewing a new revision.');
  const next=structuredClone(draft);next.revision=draft.revision+1;
  next.created_blocks.find(b=>b.id===blockId).requirements[key]=value;
  return next;
}
