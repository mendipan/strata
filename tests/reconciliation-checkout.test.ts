import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';

test('canonical fixture bytes survive a fresh Git checkout with the default Windows autocrlf setting', async () => {
  const scratchRoot = path.resolve('.strata', 's1-checkout-tests');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'checkout-'));
  const names = ['sha1.json', 'sha256.json', 'review-only.json', 'legacy-r1.json'], relative = 'tests/fixtures/reconciliation-s1';
  const originals = await Promise.all(names.map(name => readFile(`${relative}/${name}`)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !/^(OPENAI|ANTHROPIC|CLOUDFLARE_API|CF_API|STRATA_SESSION|STRATA_CONFIG)/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: directory, env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  try {
    await mkdir(path.join(directory, relative), { recursive: true });
    await writeFile(path.join(directory, '.gitattributes'), await readFile('.gitattributes'));
    for (let i = 0; i < names.length; i++) await writeFile(path.join(directory, relative, names[i]), originals[i]);
    await writeFile(path.join(directory, 'control.txt'), 'Ordinary text\nAutocrlf control\n');
    git('init'); git('add', '--', '.gitattributes', relative, 'control.txt'); git('commit', '-m', 'Synthetic fixture checkout');
    for (const name of names) await unlink(path.join(directory, relative, name)); await unlink(path.join(directory, 'control.txt'));
    git('checkout', '--', relative, 'control.txt');
    for (let i = 0; i < names.length; i++) assert.equal(Buffer.compare(await readFile(path.join(directory, relative, names[i])), originals[i]), 0, `Canonical fixture bytes changed: ${names[i]}`);
    assert.equal(await readFile(path.join(directory, 'control.txt'), 'utf8'), 'Ordinary text\r\nAutocrlf control\r\n');
  } finally {
    const target = path.resolve(directory);
    if (path.dirname(target) !== scratchRoot || !path.basename(target).startsWith('checkout-')) throw Error('Unexpected disposable checkout target.');
    await rm(target, { recursive: true, force: true });
  }
});
