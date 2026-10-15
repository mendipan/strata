import { itemRef, type Snapshot } from './model.js';

export function obligations(snapshot: Snapshot) {
  return Object.values(snapshot.blocks).sort((a, b) => a.id.localeCompare(b.id)).flatMap(block => {
    const result: { item: string; facets: string[]; criteria: string[]; value: any }[] = [];
    for (const collection of ['requirements', 'relationships', 'acceptance'] as const) for (const key of Object.keys(block[collection]).sort()) {
      const value = block[collection][key];
      result.push({ item: itemRef(block.id, `${collection}.${key}`), facets: collection === 'requirements' ? (value as any).facets : [], criteria: collection === 'acceptance' ? [itemRef(block.id, `acceptance.${key}`)] : (value as any).acceptance.map((c: string) => itemRef(block.id, 'acceptance.' + c)), value });
    }
    for (const collection of ['inputs', 'outputs', 'failures'] as const) for (const [key, value] of Object.entries(block.contract[collection])) result.push({ item: itemRef(block.id, `contract.${collection}.${key}`), facets: [], criteria: value.acceptance.map(c => itemRef(block.id, 'acceptance.' + c)), value });
    // Purpose is normative and is explicitly bound to review, rather than silently ignored.
    result.push({ item: itemRef(block.id, 'purpose'), facets: [], criteria: Object.keys(block.acceptance).filter(k => block.acceptance[k].method === 'review').map(k => itemRef(block.id, 'acceptance.' + k)), value: block.purpose });
    return result;
  });
}
