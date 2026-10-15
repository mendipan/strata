import type { Records, Layer } from '../model.js';

// Core must not import adoption schemas: native source schemas import Core too.
export function adoptionRequired(records: Records, layer: Layer): boolean {
  return Object.values(records).some(record => record.type === 'adoption-proposal' && record.data.draft_ref.split('@')[0] === layer.id && Number(record.data.draft_ref.split('@')[1]) <= layer.revision);
}
