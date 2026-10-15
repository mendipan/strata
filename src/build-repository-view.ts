import type { Engine } from './core.js';
import type { Records } from './model.js';
import type { SecurityContext } from './security.js';
import type { ProfileServiceScope } from './profile-service.js';
import { visibleRecords } from './workflow.js';
import { attemptRecordType, attemptReferences } from './build-attempt-records.js';

/** One scoped snapshot/CAS projection for broker, Studio and Build. Published
 * attempt history exposes its exact historical authentication closure, including
 * receipts written by a previous actor. Orphan action receipts stay hidden.
 */
export function buildRepositoryView(engine: Engine, scope: ProfileServiceScope, context: SecurityContext): Records {
  const records = Object.fromEntries(Object.entries(visibleRecords(engine, context.principal_id)).filter(([ref, r]) =>
    (!r.data.repository_id || r.data.repository_id === scope.repository_id) && (!scope.visible || scope.visible(ref))));
  for (const r of Object.values(records)) if (attemptRecordType(r.type)) for (const pin of attemptReferences(r.type, r.data)) {
    if (engine.records[pin.ref]?.type === 'auth-receipt' && (!scope.visible || scope.visible(pin.ref))) records[pin.ref] = engine.records[pin.ref];
  }
  return records;
}
