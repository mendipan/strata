// Synthetic in-memory fake authority for the S4 Profiles browser fixture.
//
// This is NOT a live grant, NOT Studio persistence and NOT the real
// BuildProfileService: it mirrors the published S0 dispatch semantics of
// src/profile-service.ts (same command names, input/output shapes and error
// codes) against clearly synthetic records, using the dispatcher-supplied
// transpiled S0 helpers (dist/src/model.js, dist/src/build-contracts.js) for
// canonical digests and exact schema parsing. Every record it returns parses
// the supplied S0 schemas. It performs no filesystem, network or provider I/O.
import {canonical, digest, parse, StrataError} from '../../dist/src/model.js';
import {
  BUILD_LIMITS, buildProfileRecordSchema, buildSupportingRef, normalizeBuildProfile,
  repositoryContractRecordSchema
} from '../../dist/src/build-contracts.js';

const PROJECT_ID = 'demo-project';
const FIXTURE_AUTHOR = 'fixture-author';

// The registered materializer has exactly one fixed tuple and no options
// (src/build-options.ts). The archive digest here is a synthetic marker, not a
// compiled archive; choices and requirements mirror the published shape.
export const SYNTHETIC_ARCHIVE_SHA256 = digest({fixture: 'synthetic collection-host archive/1'});
const LEGACY_ARCHIVE_SHA256 = digest({fixture: 'synthetic collection-host archive/0'});
export const FIXTURE_OPTIONS = Object.freeze({
  format: 'strata-build-options/1', materializer_id: 'collection-host/1', archive_sha256: SYNTHETIC_ARCHIVE_SHA256,
  choices: Object.freeze({language: 'javascript', framework: 'none', runtime: 'node'}),
  options: Object.freeze([]), scope: 'whole-output',
  requirements: Object.freeze([
    Object.freeze({stage: 'build', subject: 'host', kind: 'runtime', id: 'node', version: Object.freeze({min_major: 22}), allowed_values: null, source_ref: 'collection-host@1'}),
    Object.freeze({stage: 'verify', subject: 'host', kind: 'runtime', id: 'node', version: Object.freeze({min_major: 22}), allowed_values: null, source_ref: 'collection-host@1'}),
    Object.freeze({stage: 'run', subject: 'target', kind: 'runtime', id: 'node', version: Object.freeze({min_major: 22}), allowed_values: null, source_ref: 'collection-host@1'})
  ]),
  destinations: Object.freeze(['local']), output_layout: 'flat-text', run_application: false, serve_application: false
});

const fail = (code, status, message, details) => {
  const error = new StrataError(code, status === 401 ? 4 : 2, message, details ?? null);
  error.status = status;
  throw error;
};
const pinFor = subject => {
  const sha256 = digest({fixture: 'synthetic build-repository auth receipt', subject});
  return {ref: 'build-repository-auth@' + sha256, sha256};
};
const reviewFor = subject => {
  const sha256 = digest({fixture: 'synthetic build-contract review', subject});
  return {ref: 'build-contract-review@' + sha256, sha256};
};

function contractRecord({id, revision, rules, preferences, previous, repositoryId}) {
  return parse(repositoryContractRecordSchema, {
    format: 'strata-repository-compatibility/1', id, revision, rules, preferences,
    project_id: PROJECT_ID, repository_id: repositoryId, previous,
    author: 'fixture-owner', auth_receipt: pinFor(`contract:${id}:${revision}`), review: reviewFor(`contract:${id}:${revision}`)
  });
}

function profileRecord({id, revision, name, contract, choices, archiveSha256, repositoryId, previous}) {
  return parse(buildProfileRecordSchema, {
    id, revision, name, contract_ref: buildSupportingRef(contract), contract_sha256: digest(contract),
    choices, materializer: {id: 'collection-host/1', archive_sha256: archiveSha256},
    format: 'strata-build-profile/1', project_id: PROJECT_ID, repository_id: repositoryId,
    previous, derived_from: previous, author: FIXTURE_AUTHOR,
    auth_receipt: pinFor(`profile:${id}:${revision}`)
  });
}

const FIXED_CHOICES = {language: 'javascript', framework: 'none', runtime: 'node'};

function seed() {
  const repositories = {};
  const addRepository = (id, chain) => {
    repositories[id] = {id, contractChain: chain, profiles: new Map()};
  };

  // demo-repo: contract at revision 2; revision 1 is retained history.
  const demo1 = contractRecord({id: 'demo-build-rules', revision: 1, repositoryId: 'demo-repo', previous: null,
    rules: [{id: 'language-reviewed', field: 'language', allowed: ['javascript', 'python'], rationale: 'Historic rule: reviewed collection output or the legacy Python service.'}],
    preferences: []});
  const demo2 = contractRecord({id: 'demo-build-rules', revision: 2, repositoryId: 'demo-repo', previous: {ref: buildSupportingRef(demo1), sha256: digest(demo1)},
    rules: [{id: 'language-reviewed', field: 'language', allowed: ['javascript'], rationale: 'Only reviewed collection-host output is admitted. JavaScript is the single implemented source language for this repository.'}],
    preferences: [{field: 'runtime', value: 'node', rationale: 'Advisory: the fixed materializer tuple already uses node. Preferences never widen hard rules.'}]});
  addRepository('demo-repo', [demo1, demo2]);
  repositories['demo-repo'].profiles.set('build-demosite', {revisions: [profileRecord({id: 'build-demosite', revision: 1, name: 'Collection site build', contract: demo2, choices: FIXED_CHOICES, archiveSha256: SYNTHETIC_ARCHIVE_SHA256, repositoryId: 'demo-repo', previous: null})]});
  repositories['demo-repo'].profiles.set('build-oldpin', {revisions: [profileRecord({id: 'build-oldpin', revision: 1, name: 'Old contract draft', contract: demo1, choices: FIXED_CHOICES, archiveSha256: SYNTHETIC_ARCHIVE_SHA256, repositoryId: 'demo-repo', previous: null})]});
  repositories['demo-repo'].profiles.set('build-legacyarchive', {revisions: [profileRecord({id: 'build-legacyarchive', revision: 1, name: 'Legacy adapter pin', contract: demo2, choices: FIXED_CHOICES, archiveSha256: LEGACY_ARCHIVE_SHA256, repositoryId: 'demo-repo', previous: null})]});

  // strict-repo: a repository rule that genuinely forbids the only compiled tuple.
  addRepository('strict-repo', [contractRecord({id: 'strict-build-rules', revision: 1, repositoryId: 'strict-repo', previous: null,
    rules: [{id: 'python-only', field: 'language', allowed: ['python'], rationale: 'Repository policy: only the Python service language is admitted for new builds in this repository.'}],
    preferences: []})]);

  // open-repo: no recorded restrictions (unspecified is not "everything implemented").
  addRepository('open-repo', [contractRecord({id: 'open-build-rules', revision: 1, repositoryId: 'open-repo', previous: null, rules: [], preferences: []})]);

  // no-contract-repo: missing contract handoff path.
  addRepository('no-contract-repo', []);

  return repositories;
}

const clone = value => structuredClone(value);

/** Mirrors resolveBuildProfile (no-target path) from src/build-compatibility.ts. */
function resolveProfile(context, input) {
  const pin = {ref: buildSupportingRef(context), sha256: digest(context)};
  const report = {
    format: 'strata-build-compatibility-report/1', repository_id: context.repository_id,
    contract_ref: pin.ref, contract_sha256: pin.sha256, target_ref: null, target_sha256: null,
    normalized_profile: null, normalized_sha256: null, checks: [], repository_valid: false,
    materialization_supported: null, runnable_here: null
  };
  const check = (id, category, state, code, message, field = null, sources = []) =>
    report.checks.push({id, category, state, code, message, field, sources});
  let profile;
  try { profile = normalizeBuildProfile(input); }
  catch (error) {
    if (!(error instanceof StrataError)) throw error;
    check('schema.profile', 'schema', 'invalid', error.code, error.message);
    return {report, options: null, support: null};
  }
  report.normalized_profile = clone(profile);
  report.normalized_sha256 = digest(profile);
  check('schema.profile', 'schema', 'satisfied', 'BUILD_PROFILE_SCHEMA_VALID', 'Build profile matches the bounded V1 schema.');
  if (profile.contract_ref !== pin.ref || profile.contract_sha256 !== pin.sha256) {
    check('repository.contract', 'repository', 'invalid', 'BUILD_CONTRACT_PIN_MISMATCH', 'Profile must adopt this exact contract revision.', 'contract_ref');
  } else {
    const ruleSource = rule => ({kind: 'repository_rule', ref: pin.ref, sha256: pin.sha256, item: rule.id, rule_version: context.format});
    for (const field of ['language', 'framework', 'runtime']) {
      const rules = context.rules.filter(r => r.field === field);
      const intersection = rules.reduce((domain, r) => domain === null ? [...r.allowed] : domain.filter(v => r.allowed.includes(v)), null);
      if (intersection !== null && intersection.length === 0)
        check('repository.intersection.' + field, 'repository', 'invalid', 'BUILD_RULE_CONFLICT', 'Hard repository rules have no common value.', field, rules.map(ruleSource));
      for (const r of rules)
        check('repository.rule.' + r.id, 'repository', r.allowed.includes(profile.choices[field]) ? 'satisfied' : 'invalid',
          r.allowed.includes(profile.choices[field]) ? 'BUILD_RULE_SATISFIED' : 'BUILD_CHOICE_FORBIDDEN', r.rationale, field, [ruleSource(r)]);
    }
  }
  report.repository_valid = !report.checks.some(c => (c.category === 'schema' || c.category === 'repository') && c.state !== 'satisfied');
  if (profile.materializer.id !== 'collection-host/1') {
    check('materializer.options', 'materializer', 'unsupported', 'UNSUPPORTED_BUILD_OPTIONS', 'No reviewed build-choice mapping exists for this exact compiled materializer.', 'materializer');
    return {report, options: null, support: null};
  }
  const options = clone(FIXTURE_OPTIONS);
  const materializerSource = {kind: 'materializer', ref: 'collection-host@1', sha256: options.archive_sha256, item: null, rule_version: options.format};
  if (profile.materializer.archive_sha256 !== options.archive_sha256)
    check('materializer.archive', 'materializer', 'unsupported', 'BUILD_MATERIALIZER_PIN_MISMATCH', 'The requested historical archive is not the registered adapter archive.', 'materializer.archive_sha256', [materializerSource]);
  else
    check('materializer.archive', 'materializer', 'satisfied', 'BUILD_MATERIALIZER_PIN_VALID', 'Exact compiled archive is available.', null, [materializerSource]);
  if (canonical(profile.choices) !== canonical(options.choices))
    check('materializer.choices', 'materializer', 'unsupported', 'BUILD_CHOICES_UNSUPPORTED', 'This materializer supports only javascript / none / node.', 'choices', [materializerSource]);
  else
    check('materializer.choices', 'materializer', 'satisfied', 'BUILD_CHOICES_SUPPORTED', 'Requested choices describe the actual fixed output.', null, [materializerSource]);
  return {report, options, support: null};
}

export function createProfilesFixture() {
  const state = {
    repositories: seed(),
    currentRepositoryId: 'demo-repo',
    session: 'live',                // 'live' | 'expired'
    delays: {},                     // command -> ms
    failures: {},                   // command -> {code, message, times, outcome_unknown}
    corruptRepository: false,       // rewrite returned record.repository_id to a foreign id
    dispatches: {},                 // command -> count (behavioral evidence for tests)
    created: []                     // synthetic receipts of accepted writes
  };
  const repository = () => state.repositories[state.currentRepositoryId];
  const headContract = () => repository().contractChain.at(-1) ?? null;
  const context = () => {
    const contract = headContract();
    if (!contract) return null;
    const pin = {ref: buildSupportingRef(contract), sha256: digest(contract), record: clone(contract)};
    return {project_id: contract.project_id, repository_id: contract.repository_id, contract: pin};
  };
  const profileHeads = () => [...repository().profiles.values()]
    .map(entry => ({entry, head: entry.revisions.at(-1)}))
    .filter(({head}) => head)
    .map(({entry, head}) => ({entry, head, ref: buildSupportingRef(head)}));
  const inspectRecord = (record, ref) => {
    const c = context();
    return {ref, sha256: digest(record), record: clone(record), archived: false,
      report: c ? resolveProfile(c.contract.record, profileInput(record)).report : null};
  };
  const profileInput = record => ({id: record.id, revision: record.revision, name: record.name,
    contract_ref: record.contract_ref, contract_sha256: record.contract_sha256,
    choices: record.choices, materializer: record.materializer});

  const commands = {
    'repository.compatibility': input => {
      if (input?.release_ref) return {contract_binding: 'missing', context: null, binding: null}; // no synthetic release bindings exist
      const c = context();
      return c ? {contract_binding: 'profile_authoring_head', context: c, binding: null}
        : {contract_binding: 'missing', context: null, binding: null};
    },
    'profile.validate': input => {
      const c = context();
      if (!c) fail('BUILD_CONTRACT_MISSING', 6, 'Repository has no profile-authoring contract.');
      if (input?.target_ref) fail('UNSUPPORTED_CAPABILITY', 8, 'Release-target validation is not part of this synthetic fixture.');
      return resolveProfile(c.contract.record, input.record);
    },
    'profile.inspect': input => {
      for (const entry of repository().profiles.values()) {
        const hit = entry.revisions.find(r => buildSupportingRef(r) === input.ref);
        if (hit) return inspectRecord(hit, input.ref);
      }
      fail('BUILD_SOURCE_UNAVAILABLE', 3, 'Exact supporting history is unavailable in this read scope.');
    },
    'profile.list': input => {
      const heads = profileHeads().filter(({head}) => !input?.contract_ref || head.contract_ref === input.contract_ref)
        .sort((a, b) => a.ref.localeCompare(b.ref));
      const visible = heads.map(h => h.ref);
      if (input?.cursor && !visible.includes(input.cursor)) fail('INVALID_CURSOR', 2, 'List cursor is not in the current visible profile selection.');
      const offset = input?.cursor ? visible.indexOf(input.cursor) + 1 : 0;
      const page = visible.slice(offset, offset + (input?.limit ?? BUILD_LIMITS.page));
      return {profiles: page.map(ref => inspectRecord(heads.find(h => h.ref === ref).head, ref)),
        cursor: offset + page.length < visible.length ? page.at(-1) : null};
    },
    'profile.create': input => admit('profile.create', input, null),
    'profile.revise': input => {
      const entry = repository().profiles.get(input.record.id);
      const head = entry?.revisions.at(-1);
      const headRef = head ? buildSupportingRef(head) : null;
      if (!head || input.previous !== headRef || input.record.revision !== head.revision + 1)
        fail('STALE_REVISION', 5, 'Profile revision must name the exact current head.');
      return admit('profile.revise', input, {ref: headRef, sha256: digest(head)});
    },
    'profile.archive': () => fail('UNSUPPORTED_CAPABILITY', 8, 'Archive is intentionally out of scope for this fixture page.')
  };

  function admit(command, input, previous) {
    const c = context();
    if (!c) fail('BUILD_CONTRACT_MISSING', 6, 'Repository has no profile-authoring contract.');
    const entry = repository().profiles.get(input.record.id);
    const head = entry?.revisions.at(-1);
    if (command === 'profile.create' && (head || input.record.revision !== 1))
      fail('BUILD_PROFILE_EXISTS', 5, 'New logical profile requires unused identity and revision one.');
    if (entry && !head) fail('BUILD_PROFILE_ARCHIVED', 5, 'Archived logical profile cannot be revised.');
    const result = resolveProfile(c.contract.record, input.record);
    if (result.report.normalized_sha256 !== input.expected_normalized_sha256)
      fail('BUILD_PROFILE_DIGEST_MISMATCH', 5, 'Normalized profile differs from the reviewed expected digest.');
    if (!result.report.repository_valid || result.report.checks.some(ch => ch.category === 'materializer' && ch.state !== 'satisfied'))
      fail('BUILD_PROFILE_INVALID', 8, 'Profile cannot be saved with invalid rules or unsupported compiled choices.', result.report);
    if (!head && new Set(profileHeads().map(h => h.head.id)).size >= BUILD_LIMITS.profiles)
      fail('BUILD_PROFILE_LIMIT', 5, 'Repository logical profile capacity is full.');
    const record = parse(buildProfileRecordSchema, {
      ...input.record, format: 'strata-build-profile/1', project_id: c.project_id, repository_id: c.repository_id,
      previous, derived_from: previous, author: FIXTURE_AUTHOR, auth_receipt: pinFor(`${command}:${input.record.id}:${input.record.revision}`)
    });
    const ref = buildSupportingRef(record);
    if (!entry) repository().profiles.set(input.record.id, {revisions: []});
    repository().profiles.get(input.record.id).revisions.push(record);
    state.created.push({command, ref, id: record.id, revision: record.revision, expected_normalized_sha256: input.expected_normalized_sha256});
    return {ref, sha256: digest(record), record: clone(record), report: clone(result.report)};
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  return {
    /** Synthetic authority note shown by consumers that care about labeling. */
    syntheticNote: 'Synthetic fixture authority: in-memory records only; no live grant, provider or Studio persistence.',
    async execute(command, input) {
      state.dispatches[command] = (state.dispatches[command] ?? 0) + 1;
      if (state.delays[command]) await sleep(state.delays[command]);
      const injected = state.failures[command];
      if (injected && injected.times > 0) {
        injected.times -= 1;
        if (injected.outcome_unknown) {
          const error = new Error(injected.message);
          error.code = injected.code;
          error.status = injected.status ?? 502;
          error.outcome_unknown = true;
          throw error;
        }
        fail(injected.code, injected.status ?? 422, injected.message);
      }
      if (state.session === 'expired' && (command === 'profile.create' || command === 'profile.revise'))
        fail('OWNER_SESSION_REQUIRED', 401, 'Your Studio session expired. Recover your session to continue saving.');
      const handler = commands[command];
      if (!handler) fail('UNSUPPORTED_CAPABILITY', 8, 'Unknown profile repository operation.');
      const result = handler(input);
      if (state.corruptRepository && result && typeof result === 'object') {
        for (const item of result.profiles ?? []) item.record.repository_id = 'foreign-repo';
        if (result.record?.repository_id) result.record.repository_id = 'foreign-repo';
      }
      return result;
    },
    control(action, value) {
      switch (action) {
        case 'select-repository': state.currentRepositoryId = String(value); return true;
        case 'expire-session': state.session = 'expired'; return true;
        case 'refresh-session': state.session = 'live'; return true;
        case 'set-delay': state.delays[value.command] = Number(value.ms) || 0; return true;
        case 'set-failure': state.failures[value.command] = {code: value.code, message: value.message, times: value.times ?? 1, outcome_unknown: value.outcome_unknown === true, status: value.status}; return true;
        case 'clear-behaviors': state.delays = {}; state.failures = {}; state.corruptRepository = false; state.session = 'live'; return true;
        case 'corrupt-repository': state.corruptRepository = value === true; return true;
        case 'advance-contract': {
          const repo = repository();
          const current = repo.contractChain.at(-1);
          const revision = (current?.revision ?? 0) + 1;
          repo.contractChain.push(contractRecord({id: current?.id ?? 'build-rules', revision, repositoryId: repo.id,
            previous: current ? {ref: buildSupportingRef(current), sha256: digest(current)} : null,
            rules: current?.rules ?? [], preferences: current?.preferences ?? []}));
          return buildSupportingRef(repo.contractChain.at(-1));
        }
        case 'advance-profile-head': {
          const entry = repository().profiles.get(String(value));
          if (!entry) return false;
          const head = entry.revisions.at(-1);
          const next = profileRecord({id: head.id, revision: head.revision + 1, name: head.name + ' (updated by another author)',
            contract: headContract(), choices: head.choices, archiveSha256: SYNTHETIC_ARCHIVE_SHA256, repositoryId: repository().id,
            previous: {ref: buildSupportingRef(head), sha256: digest(head)}});
          entry.revisions.push(next);
          return buildSupportingRef(next);
        }
        case 'reset': Object.assign(state, {repositories: seed(), currentRepositoryId: 'demo-repo', session: 'live', delays: {}, failures: {}, corruptRepository: false, dispatches: {}, created: []}); return true;
        default: throw new Error('Unknown fixture control: ' + action);
      }
    },
    stats() {
      return {dispatches: {...state.dispatches}, currentRepositoryId: state.currentRepositoryId, session: state.session,
        created: state.created.map(c => ({...c})),
        contractHead: headContract() ? buildSupportingRef(headContract()) : null,
        heads: profileHeads().map(h => ({id: h.head.id, revision: h.head.revision, ref: h.ref, name: h.head.name, repositoryId: h.head.repository_id}))};
    },
    /** Exact stored bytes for immutability assertions. */
    recordDigest(ref) {
      for (const repo of Object.values(state.repositories)) {
        for (const entry of repo.profiles.values()) {
          const hit = entry.revisions.find(r => buildSupportingRef(r) === ref);
          if (hit) return digest(hit);
        }
      }
      return null;
    }
  };
}
