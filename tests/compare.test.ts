import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compare, project, validPath } from '../src/core/compare.ts';
import { readDisk } from '../src/core/disk.ts';
import type { Entry } from '../src/core/model.ts';
import { DEFAULT_PROJECTION } from '../src/core/model.ts';
import { parseEntries, parseProjection } from '../src/core/protocol.ts';
import { parseScenario, scenarios } from '../src/core/scenarios.ts';

const file = (path: string, version = 'a'): Entry => ({
  path,
  type: 'file',
  hash: version.repeat(64),
});
test('comparison classifies all four differences, independent of order', () => {
  const disk: Entry[] = [
    file('missing'),
    file('content'),
    { path: 'type', type: 'directory' },
    file('same'),
  ];
  const index: Entry[] = [file('same'), file('type'), file('content', 'b'), file('extra')];
  assert.deepEqual(
    compare(disk, index).map((d) => [d.path, d.kind]),
    [
      ['content', 'content-mismatch'],
      ['extra', 'extra'],
      ['missing', 'missing'],
      ['type', 'type-mismatch'],
    ],
  );
  assert.deepEqual(compare(disk, [...disk].reverse()), []);
});
test('scope uses literal path/subtree prefixes symmetrically; no implicit dotfile exclusion', () => {
  const scope = { ...DEFAULT_PROJECTION, excludes: ['build'] };
  const disk = [file('build/a'), file('builder/a'), file('.hidden')],
    index = [file('build/stale'), file('.hidden'), file('builder/a')];
  assert.deepEqual(compare(project(disk, scope), project(index, scope)), []);
  assert.equal(project(disk, scope).length, 2);
});
test('snapshot and projection reject unsafe paths, duplicates and invalid hashes', () => {
  for (const path of ['/etc', '../x', 'a/../b', 'a\\b', 'C:/x', './a', 'a//b', 'a/', 'a\n'])
    assert.equal(validPath(path), false, path);
  assert.equal(validPath('каталог/file.txt'), true);
  assert.throws(() => parseEntries([file('a'), file('a')]));
  assert.throws(() => parseEntries([{ path: 'a', type: 'file', hash: 'garbage' }]));
  assert.throws(() => parseEntries([{ path: 'link', type: 'symlink' }]));
  assert.throws(() => parseProjection({ ...DEFAULT_PROJECTION, hash: 'md5' }));
  assert.throws(() => parseProjection({ ...DEFAULT_PROJECTION, excludes: ['../out'] }));
});
test('independent disk walk hashes contents, includes empty directories, skips symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchconverge-test-'));
  try {
    await mkdir(join(root, 'tree'));
    await mkdir(join(root, 'outside'));
    await mkdir(join(root, 'tree/empty'));
    await writeFile(join(root, 'outside/secret'), 'not in scope');
    await writeFile(join(root, 'tree/a'), 'abc');
    await symlink(
      join(root, 'outside'),
      join(root, 'tree/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = await readDisk(join(root, 'tree'), DEFAULT_PROJECTION);
    assert.deepEqual(
      result.entries,
      [file('a', 'x'), { path: 'empty', type: 'directory' }].map((e) =>
        e.type === 'file'
          ? { ...e, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }
          : e,
      ),
    );
    assert.deepEqual(result.skipped, ['link']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('scenario replay validates all filesystem paths before writes', () => {
  for (const scenario of scenarios) assert.equal(parseScenario(scenario), scenario);
  assert.throws(() =>
    parseScenario({ ...scenarios[0], initial: [{ path: '../escape', content: 'x' }] }),
  );
  assert.throws(() =>
    parseScenario({
      ...scenarios[0],
      steps: [{ name: 'bad', operations: [{ kind: 'rename', path: 'a', to: '/outside' }] }],
    }),
  );
});
