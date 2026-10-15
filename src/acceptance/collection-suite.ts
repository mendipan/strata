// Independent acceptance observations and literal expectations. No profile checker,
// generated config, oracle builder, application-provided test or review assertion.
export const COLLECTION_SURFACES = ['lifecycle', 'detached', 'identifiers', 'titles', 'atomic', 'capacity', 'instance-reset'] as const;
export type CollectionSurface = typeof COLLECTION_SURFACES[number];
export type CollectionObservations = Record<CollectionSurface, unknown>;
const copy = (value: any) => JSON.parse(JSON.stringify(value));

export function observeCollection(module: any): CollectionObservations {
  const lifecycle = module.createCollection();
  const lifecycleTrace = [copy(lifecycle.list()), copy(lifecycle.add('c', 'a')), copy(lifecycle.add('a', 'a')), copy(lifecycle.add('b', 'a')), copy(lifecycle.list()), copy(lifecycle.get('c')), copy(lifecycle.complete('c')), copy(lifecycle.complete('c')), copy(lifecycle.remove('c')), copy(lifecycle.list())];
  const detached = module.createCollection(), added = detached.add('a', 'a');
  const detachedTrace = [copy(added)]; added.item.title = 'changed'; added.item.completed = true;
  const got = detached.get('a'); detachedTrace.push(copy(got)); got.item.id = 'changed';
  const listed = detached.list(); detachedTrace.push(copy(listed)); listed[0].title = 'changed'; listed.push({ id: 'extra' });
  detachedTrace.push(copy(detached.list())); const completed = detached.complete('a'); detachedTrace.push(copy(completed)); completed.item.title = 'changed'; detachedTrace.push(copy(detached.get('a')));
  const ids = module.createCollection(), invalidIds = ['', '_first', 'a b', 'a\n', 'a\r\n', 'x'.repeat(33), '\u00e9'];
  const identifiers = invalidIds.map(id => [copy(ids.add(id, 'a')), copy(ids.get(id)), copy(ids.complete(id)), copy(ids.remove(id)), copy(ids.list())]);
  identifiers.push([copy(ids.add('x'.repeat(32), 'a')), copy(ids.remove('x'.repeat(32)))]);
  const titles = module.createCollection(), astral = '\u{1f642}'.repeat(20);
  const titleTrace = [copy(titles.add('a', ' ')), copy(titles.add('a', astral + 'a')), copy(titles.add('a', astral)), copy(titles.remove('a')), copy(titles.add('a', ' a ')), copy(titles.get('a'))];
  const atomic = module.createCollection(); atomic.add('a', 'a');
  const atomicTrace = [copy(atomic.add('a', 'a')), copy(atomic.add('a', ' ')), copy(atomic.add('a', 'x'.repeat(21))), copy(atomic.get('missing')), copy(atomic.complete('missing')), copy(atomic.remove('missing')), copy(atomic.list())];
  const capacity = module.createCollection(), capacityTrace = [];
  for (let i = 1; i <= 6; i++) capacityTrace.push(copy(capacity.add('i' + i, 'a')));
  capacityTrace.push(copy(capacity.list()), copy(capacity.remove('i1')), copy(capacity.add('replacement', 'a')), copy(capacity.list()));
  const first = module.createCollection(), second = module.createCollection(); first.add('a', 'a');
  return { lifecycle: lifecycleTrace, detached: detachedTrace, identifiers, titles: titleTrace, atomic: atomicTrace, capacity: capacityTrace, 'instance-reset': [copy(first.list()), copy(second.list()), copy(module.createCollection().list())] };
}

export function expectedCollection(capacity: 3 | 5): CollectionObservations {
  const item = (id: string, title = 'a', completed = false) => ({ id, title, completed });
  const ok = (id: string, title = 'a', completed = false) => ({ accepted: true, item: item(id, title, completed) });
  const no = (reason: string) => ({ accepted: false, reason });
  const rows = Array.from({ length: capacity }, (_, i) => item('i' + (i + 1)));
  return {
    lifecycle: [[], ok('c'), ok('a'), ok('b'), [item('a'), item('b'), item('c')], ok('c'), ok('c', 'a', true), ok('c', 'a', true), ok('c', 'a', true), [item('a'), item('b')]],
    detached: [ok('a'), ok('a'), [item('a')], [item('a')], ok('a', 'a', true), ok('a', 'a', true)],
    identifiers: [...Array.from({ length: 7 }, () => [no('invalid'), no('invalid'), no('invalid'), no('invalid'), []]), [ok('x'.repeat(32)), ok('x'.repeat(32))]],
    titles: [no('invalid'), no('title_too_long'), ok('a', '\u{1f642}'.repeat(20)), ok('a', '\u{1f642}'.repeat(20)), ok('a', ' a '), ok('a', ' a ')],
    atomic: [no('duplicate'), no('invalid'), no('title_too_long'), no('missing'), no('missing'), no('missing'), [item('a')]],
    capacity: [...Array.from({ length: 6 }, (_, i) => i < capacity ? ok('i' + (i + 1)) : no('limit')), rows, ok('i1'), ok('replacement'), [...rows.slice(1), item('replacement')]],
    'instance-reset': [[item('a')], [], []]
  };
}
