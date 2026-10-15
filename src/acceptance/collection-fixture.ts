import { canonical } from '../model.js';
import { collectionProfile } from '../profiles/collection.js';

// An independently authored, fixed Array implementation. Never supplied app code.
export const ORIGINAL_COLLECTION = `export function createCollection() {
  let rows = [];
  const copy = row => ({ id: row.id, title: row.title, completed: row.completed });
  const reject = reason => ({ accepted: false, reason });
  const accept = row => ({ accepted: true, item: copy(row) });
  const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.exec(id)?.[0] === id;
  return {
    add(id, title) {
      if (!valid(id) || typeof title !== 'string' || title.trim().length === 0) return reject('invalid');
      if (Array.from(title).length > 20) return reject('title_too_long');
      if (rows.some(row => row.id === id)) return reject('duplicate');
      if (rows.length === 3) return reject('limit');
      const row = { id, title, completed: false }; rows.push(row); return accept(row);
    },
    get(id) { if (!valid(id)) return reject('invalid'); const row = rows.find(row => row.id === id); return row ? accept(row) : reject('missing'); },
    list() { return rows.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(copy); },
    complete(id) { if (!valid(id)) return reject('invalid'); const row = rows.find(row => row.id === id); if (!row) return reject('missing'); row.completed = true; return accept(row); },
    remove(id) { if (!valid(id)) return reject('invalid'); const row = rows.find(row => row.id === id); if (!row) return reject('missing'); rows = rows.filter(value => value.id !== id); return accept(row); }
  };
}
`;

export type CollectionLane = 'original' | 'baseline' | 'changed';
export function trustedCollectionSource(lane: CollectionLane): string {
  if (lane === 'original') return ORIGINAL_COLLECTION;
  if (lane !== 'baseline' && lane !== 'changed') throw new Error('UNSUPPORTED_LANE');
  const template = (collectionProfile.archive() as { template: string }).template;
  return template.replace('__CONFIG__', canonical({ max_items: lane === 'baseline' ? 3 : 5, max_title_length: 20 }));
}
