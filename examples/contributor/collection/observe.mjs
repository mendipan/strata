// An independently runnable literal behavior check. No engine/profile/oracle imports.
// Run only the explicitly selected, locally materialized compiled collection.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function observe(directory, stage, expectedCapacity = stage === 'baseline' ? 3 : 5) {
  if (!path.isAbsolute(directory) || !['baseline', 'changed'].includes(stage)) throw new Error('Use an absolute output directory and baseline|changed.');
  const { createCollection, auditEnabled } = await import(pathToFileURL(path.join(directory, 'collection.mjs')).href);
  if (!Number.isInteger(expectedCapacity) || expectedCapacity < 2 || expectedCapacity > 32 || stage === 'baseline' && expectedCapacity !== 3) throw new Error('Supply a literal supported expectation.');
  const capacity = expectedCapacity, audited = stage === 'changed';
  assert.equal(auditEnabled, audited);
  const c = createCollection();
  assert.deepEqual(c.list(), []);
  assert.equal(typeof c.audit === 'function', audited);
  assert.deepEqual(c.add('bad id', 'title'), { accepted:false, reason:'invalid' });
  assert.deepEqual(c.add('blank', '  '), { accepted:false, reason:'invalid' });
  assert.deepEqual(c.add('long', '😀'.repeat(21)), { accepted:false, reason:'title_too_long' });
  assert.equal(c.add('unicode', '😀'.repeat(20)).accepted, true);
  const detached = c.get('unicode'); detached.item.title='mutated';
  assert.equal(c.get('unicode').item.title, '😀'.repeat(20));
  assert.equal(c.remove('unicode').accepted, true);
  for (let i=0; i<capacity; i++) assert.equal(c.add('item'+i, 'Item '+i).accepted, true);
  const before = c.list();
  assert.deepEqual(c.add('overflow', 'Overflow'), { accepted:false, reason:'limit' });
  assert.deepEqual(c.add('item0', 'Duplicate'), { accepted:false, reason:'duplicate' });
  assert.deepEqual(c.list(), before);
  const copied = c.list(); copied[0].completed=true;
  assert.equal(c.get('item0').item.completed, false);
  const countBeforeReads = audited ? c.audit().length : null;
  c.list(); c.get('item0'); c.get('absent');
  if (audited) assert.equal(c.audit().length, countBeforeReads);
  assert.equal(c.complete('item0').accepted, true);
  const afterComplete = audited ? c.audit().length : null;
  assert.equal(c.complete('item0').accepted, true);
  if (audited) assert.equal(c.audit().length, afterComplete);
  assert.equal(c.remove('item0').accepted, true);
  assert.deepEqual(c.remove('item0'), { accepted:false, reason:'missing' });
  if (audited) {
    const history=c.audit();
    assert.deepEqual(history.map(event=>event.sequence), Array.from({length:capacity+4},(_,i)=>i+1));
    assert.deepEqual(history.map(event=>event.operation), ['add','remove',...Array(capacity).fill('add'),'complete','remove']);
    history[0].item.title='changed'; history.pop();
    assert.equal(c.audit().length, capacity+4);
    assert.equal(c.audit()[0].item.title, '😀'.repeat(20));
  }
  const fresh=createCollection();
  assert.deepEqual(fresh.list(), []);
  if (audited) assert.deepEqual(fresh.audit(), []);
  return { format:'contributor-observations/1', stage, passed:true, capacity, audit:audited,
    unicode_code_points:20, rejected_overflow_unchanged:true, detached_reads:true,
    successful_mutations_only:audited ? true : null, new_instance_empty:true,
    boundary:'Literal observations of the selected output. No validation, review, approval, deployment or persistence claim.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await observe(process.argv[2],process.argv[3],process.argv[4]===undefined?undefined:Number(process.argv[4])))); }
  catch { console.error(JSON.stringify({ok:false,code:'OBSERVATION_FAILED',message:'The selected output did not satisfy the literal starter observations.'})); process.exitCode=6; }
}
