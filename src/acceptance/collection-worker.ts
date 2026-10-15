import { trustedCollectionSource, type CollectionLane } from './collection-fixture.js';
import { observeCollection } from './collection-suite.js';

// Launched only by the local fixed harness. Input is rechecked against compiled
// allowlisted bytes before data-URL import; cwd files cannot replace executed code.
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 32 * 1024) throw new Error('INPUT_LIMIT'); chunks.push(Buffer.from(chunk)); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || Object.keys(input).sort().join(',') !== 'lane,source' || !['original', 'baseline', 'changed'].includes(input.lane) || input.source !== trustedCollectionSource(input.lane as CollectionLane)) throw new Error('UNSUPPORTED_SOURCE');
  const module = await import('data:text/javascript;base64,' + Buffer.from(input.source).toString('base64'));
  console.log(JSON.stringify({ format: 'collection-observations/1', runtime: process.version, observations: observeCollection(module) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'WORKER_FAILED'); process.exitCode = 1;
}
