import type { Evaluation } from './core.js';
import { canonical, fail, item, type Approval, type Snapshot } from './model.js';

/** The existing publication authority predicate, shared with historical reads. */
export function assertPublicationApprovals(baseline: Snapshot, evaluation: Evaluation, evidenceDigest: string, approvals: Approval[]) {
  if (approvals.some(a => a.target !== evaluation.fingerprint || a.evidence_digest !== evidenceDigest)) fail('STALE_APPROVAL', 6, 'All approvals must bind this candidate and evidence digest.');
  const scopeAuthority = baseline.authorities.scopes.find(s => s.block === evaluation.scope)!;
  if (!approvals.some(a => a.kind === 'scope' && a.scope === evaluation.scope && scopeAuthority.selectors.includes(a.principal))) fail('ENDORSEMENT_REQUIRED', 6, 'Every normative candidate needs responsible-scope approval.');
  if (!approvals.some(a => a.kind === 'release' && baseline.authorities.release.includes(a.principal))) fail('RELEASE_APPROVAL_REQUIRED', 6, 'Project release authority must approve the exact validated candidate.');
  for (const guardian of baseline.authorities.guardians) {
    const [block, path] = guardian.item.split('/');
    if (canonical(item(baseline.blocks[block], path).value) !== canonical(item(evaluation.snapshot.blocks[block], path).value) && !approvals.some(a => a.kind === 'guardian' && a.scope === guardian.item && a.principal === guardian.principal)) fail('GUARDIAN_REQUIRED', 6, 'A protected invariant amendment needs its fixed baseline guardian.');
  }
}
