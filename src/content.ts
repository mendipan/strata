import { CONTENT_MODEL, MODEL, contentSnapshotSchema, digest, fail, normalizeSnapshot, type Snapshot } from './model.js';
import { snapshotFromRelease } from './core.js';

// Preview is a pure projection. It never writes records or changes a baseline.
export function migrationPreview(sourceRef: string, source: unknown, expectedDigest: string) {
  if (digest(source) !== expectedDigest) fail('MIGRATION_SOURCE_MISMATCH',6,'Preview requires the exact trusted source record digest.');
  const snapshot=snapshotFromRelease(source); if(snapshot.model_version!==MODEL) fail('UNSUPPORTED_MODEL_VERSION',8,'Only an explicit v0.1 source Release can be previewed.'); normalizeSnapshot(snapshot);
  const proposal: Snapshot={...structuredClone(snapshot),model_version:CONTENT_MODEL};
  for(const block of Object.values(proposal.blocks)) { block.description={format:'plain-text/1',text:''}; block.asset_refs={}; }
  const result=contentSnapshotSchema.safeParse(proposal); const blockers: {path:string;code:string;message:string}[] = result.success ? [] : result.error.issues.map(issue=>({path:issue.path.join('.'),code:'CONTENT_CONTRACT',message:issue.message}));
  try { normalizeSnapshot(proposal); } catch(error:any) { if(error.code!=='INVALID_RECORD') blockers.push({path:'snapshot',code:error.code ?? 'INVALID_PREVIEW',message:error.message}); }
  return {format:'strata-migration-preview/1',source_ref:sourceRef,source_sha256:expectedDigest,source_model:MODEL,target_model:CONTENT_MODEL,proposal,proposal_sha256:digest(proposal),mapping:Object.keys(snapshot.blocks).sort().map(id=>({source_block:id,target_block:id,added:['description','asset_refs'],preserved:['id','parent','purpose','requirements','acceptance','relationships','contract']})),blockers,eligible_for_manual_review:blockers.length===0,applied:false,limits:['Preview only; active-project migration is unavailable.','Descriptions are empty and require authoring review. No URLs or assets are imported.','No baseline switch, approval, authority grant or source rewrite occurs.']};
}
