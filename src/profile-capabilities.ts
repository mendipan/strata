import { CONTENT_MODEL, StrataError, digest, fail } from './model.js';
import type { ProfileAdapter, Realization } from './profile-types.js';

export type ProfileSupportDetail = {
  id: string; archive_sha256: string; models: readonly string[];
  backend: 'node'; scenario: { id: string; version: string };
  evidence: { trust: 'synthetic-local-fixture' | 'authenticated-host'; checker_bound: boolean; review: 'fixture-attestation' | 'authenticated-criterion-attestation'; approvals: 'separate-required' };
  runtime: { minimum_node_major: 22; output_layout: 'flat-text'; outputs: readonly string[] };
  topology: readonly string[]; semantic_bounds: readonly string[]; check_families: readonly string[];
  limitations: readonly string[]; source: readonly string[];
};
type Notes = Pick<ProfileSupportDetail, 'topology' | 'semantic_bounds' | 'check_families' | 'limitations' | 'source'> & { outputs: string[]; evidence?: Pick<ProfileSupportDetail['evidence'], 'trust' | 'review'> };
const booking: Notes = {
  topology: ['app', 'booking', 'booking.hold', 'booking.reminder'],
  semantic_bounds: ['Exact recognized booking purposes, atomic requirement and contract meanings; design facets refused.', 'Expiry is an integer 1-86400 seconds; enabled reminder uses a nonnegative integer lead strictly before expiry.', 'Unsupported subjects, missing required check families, and unknown active obligations refuse.'],
  check_families: ['booking.exclusive', 'booking.expiry', 'booking.reminder', 'booking.once', 'booking.lifecycle', 'intent.review'],
  outputs: ['booking.mjs', 'intent.json', 'README.md'],
  limitations: ['The existing adapter reports recognized obligation and check-edge failures; this description is not an exhaustive support proof.', 'Legacy booking-node/1 and /2 do not bind checker, fixture and oracle pins.'],
  source: ['src/profiles/booking.ts', 'src/profiles/booking-checker.ts', 'src/profiles/booking-runner.ts']
};
const finiteNotes: Record<string, Notes> = {
  'booking-node/1': booking, 'booking-node/2': booking, 'booking-node/3': booking, 'booking-node/4': booking,
  'counter-fixture/1': {
    topology: ['counter (single root)'], semantic_bounds: ['Positive safe integer additions; maximum is an integer 2-1000.', 'Exact counter purposes, requirements, contracts, acceptance claims and required check families.'],
    check_families: ['counter.add', 'counter.limit', 'counter.invalid', 'intent.review'], outputs: ['counter.mjs', 'README.md'], limitations: ['In-memory synthetic counter; no persistence or general application behavior.'], source: ['src/profiles/counter-fixture.ts']
  },
  'counter-host/1': {
    topology: ['counter (single root)'], semantic_bounds: ['Reuses the exact compiled counter purposes, requirements, contracts, acceptance claims and mechanical checker.', 'Maximum is an integer 2-1000; background assets and additional Blocks are unsupported.'],
    check_families: ['counter.add', 'counter.limit', 'counter.invalid', 'intent.review'], outputs: ['counter.mjs', 'README.md'],
    evidence: { trust: 'authenticated-host', review: 'authenticated-criterion-attestation' },
    limitations: ['Requires an explicitly configured allowlisted measured host runner and separate authenticated criterion review; profile support does not establish runner availability or grants.', 'In-memory bounded counter; no persistence or arbitrary Block realization.'],
    source: ['src/profiles/counter-host.ts', 'src/profiles/counter-fixture.ts', 'src/auth/runner.ts', 'src/auth/records.ts']
  },
  'collection-node/1': {
    topology: ['collection (root)', 'items (child of collection)', 'policy (child of collection)'],
    semantic_bounds: ['max_items is an integer 1-1000; max_title_length is an integer 1-200.', 'IDs match [A-Za-z0-9][A-Za-z0-9_-]{0,31}; title length uses JavaScript Unicode code point iteration.', 'Exact purposes, requirements, relationships, interfaces, failures and acceptance claims; no additional Blocks or semantic keys.', 'Per-instance in-memory state, detached reads, ASCII ID order and atomic explicit failures.'],
    check_families: ['collection.lifecycle', 'collection.detached', 'collection.invalid', 'collection.limits', 'collection.atomic', 'intent.review'], outputs: ['collection.mjs', 'README.md'],
    limitations: ['v0.2, optional audit Block and collection-host/1 are unsupported in this local slice.', 'No persistence, clock, random values, network, package dependency, arbitrary application generation or behavioral equivalence.'],
    source: ['src/profiles/collection.ts', 'src/profiles/collection-semantics.ts', 'src/profiles/collection-checker.ts']
  },
  'collection-host/1': {
    topology: ['collection (root)', 'items (child of collection)', 'policy (child of collection)', 'audit (optional child of collection)'],
    semantic_bounds: ['Reuses the exact finite collection meanings and mechanical checks; max_items 1-1000 and max_title_length 1-200 Unicode code points.', 'Optional audit has exact links/contracts/criteria and records successful state changes with detached consecutive events; rejected operations and repeated completion add none.', 'Only v0.3; unknown Blocks, semantic items, parameters and background assets refuse.'],
    check_families: ['collection.lifecycle', 'collection.detached', 'collection.invalid', 'collection.limits', 'collection.atomic', 'collection.audit', 'intent.review'], outputs: ['collection.mjs', 'README.md'],
    evidence: { trust: 'authenticated-host', review: 'authenticated-criterion-attestation' },
    limitations: ['Requires an explicit allowlisted measured host runner and separate authenticated criterion review; this metadata supplies no runner slot, grant or approval.', 'Only the optional finite audit Block is supported; no arbitrary topology, persistence, application generation, source binding or behavioral equivalence.'],
    source: ['src/profiles/collection-host.ts', 'src/profiles/collection-host-semantics.ts', 'src/profiles/collection-host-checker.ts', 'src/auth/runner.ts', 'src/auth/records.ts']
  }
};

/** Explanatory metadata for a finite compiled adapter, never a capability grant. */
export function describeProfileSupport(adapter: ProfileAdapter): ProfileSupportDetail {
  if (!Object.hasOwn(finiteNotes, adapter.id)) fail('UNSUPPORTED_PROFILE', 8, 'No reviewed support description exists for this compiled profile.', { id: adapter.id });
  const notes = finiteNotes[adapter.id];
  const content = adapter.models.includes(CONTENT_MODEL);
  return {
    id: adapter.id, archive_sha256: digest(adapter.archive()), models: [...adapter.models], backend: 'node', scenario: { id: adapter.scenario.id, version: adapter.scenario.version },
    evidence: { trust: notes.evidence?.trust ?? 'synthetic-local-fixture', checker_bound: adapter.boundEvidence, review: notes.evidence?.review ?? 'fixture-attestation', approvals: 'separate-required' },
    runtime: { minimum_node_major: 22, output_layout: 'flat-text', outputs: [...notes.outputs, ...(content ? ['assets.json'] : [])] },
    topology: [...notes.topology], semantic_bounds: [...notes.semantic_bounds], check_families: [...notes.check_families], source: [...notes.source],
    limitations: [...notes.limitations, ...(content ? ['v0.2 requires explicit mediation and retained background asset closure; this descriptor supplies neither.'] : ['This adapter does not support v0.2.']), 'SDK checker execution is unsupported.', 'Support is not permission, a passing check, review, approval, Release or deployment; exact adapter/core predicates are authoritative.']
  };
}

export type ProfileSupportReport = {
  profile: ProfileSupportDetail;
  materialization: { supported: true } | { supported: false; first_blocker: { code: string; exit: number; message: string; details: unknown } };
};
/** The shared workflow supplies its actual Engine.realize attempt. No alternative predicates,
 * adapter selection, identity, grants or evidence are implemented here. Direct adapter tests
 * may supply their adapter attempt, which proves only that adapter's finite support. */
export function inspectProfileSupport(adapter: ProfileAdapter, attempt: () => Realization): ProfileSupportReport {
  const profile = describeProfileSupport(adapter);
  try {
    const result = attempt();
    if (result.profile_id !== adapter.id || result.profile !== profile.archive_sha256 || !adapter.models.includes(result.model_version)) fail('STALE_REALIZATION', 6, 'Support probe returned a realization for another profile or model.');
    return { profile, materialization: { supported: true } };
  }
  catch (error) {
    if (!(error instanceof StrataError)) throw error;
    return { profile, materialization: { supported: false, first_blocker: { code: error.code, exit: error.exit, message: error.message, details: error.details } } };
  }
}
