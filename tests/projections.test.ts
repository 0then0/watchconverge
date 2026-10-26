import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compare, project } from '../src/core/compare.ts';
import { readDisk } from '../src/core/disk.ts';
import { DEFAULT_PROJECTION, type Projection } from '../src/core/model.ts';
import { parseEntries, parseProjection } from '../src/core/protocol.ts';
import { renderReport } from '../src/core/report.ts';
import { runScenario } from '../src/core/runner.ts';
import { scenarios } from '../src/core/scenarios.ts';

const paths: Projection = { ...DEFAULT_PROJECTION, hash: 'none' };
const command = (mode: string) => [
  process.execPath,
  fileURLToPath(new URL('./fixtures/adapter.mjs', import.meta.url)),
  mode,
];
const run = (mode: string, scenario = scenarios[4]) =>
  runScenario({ scenario, command: command(mode), windowMs: 120, pollMs: 20 });

test('projection must explicitly select none or sha256; missing or malformed hash never downgrades', () => {
  assert.equal(parseProjection(paths).hash, 'none');
  const entries = [{ path: 'a', type: 'file' }];
  assert.deepEqual(parseEntries(entries, paths), entries);
  assert.throws(() => parseEntries(entries));
  assert.throws(() => parseEntries(entries, DEFAULT_PROJECTION));
  for (const hash of [undefined, null, '', false, 'SHA256', 'md5'])
    assert.throws(() => parseProjection({ ...paths, hash }));
  assert.throws(() => parseEntries([{ ...entries[0], hash: 'invalid' }], paths));
  assert.throws(() => parseEntries([...entries, ...entries], paths));
  assert.throws(() => parseEntries([{ path: '../outside', type: 'file' }], paths));
  assert.throws(() => parseEntries([{ path: 'a', type: 'symlink' }], paths));
  assert.throws(() =>
    parseEntries(
      Array.from({ length: 10001 }, (_, i) => ({ path: `a${i}`, type: 'file' })),
      paths,
    ),
  );
});

test('path projection strips hashes symmetrically; sha256 compares stale content at equal paths', () => {
  const disk = [{ path: 'a', type: 'file' as const, hash: 'a'.repeat(64) }];
  const index = [{ ...disk[0], hash: 'b'.repeat(64) }];
  assert.equal(
    compare(project(disk, DEFAULT_PROJECTION), project(index, DEFAULT_PROJECTION))[0].kind,
    'content-mismatch',
  );
  assert.deepEqual(compare(project(disk, paths), project(index, paths)), []);
  assert.equal(compare(project(disk, paths), [])[0].kind, 'missing');
});

test('paths disk traversal does not need permission to read file contents', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0
      ? 'Requires non-root POSIX permissions'
      : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchconverge-paths-'));
  try {
    await writeFile(join(root, 'a'), 'private');
    await chmod(join(root, 'a'), 0);
    assert.deepEqual((await readDisk(root, paths)).entries, [{ path: 'a', type: 'file' }]);
    await assert.rejects(readDisk(root, DEFAULT_PROJECTION), { code: 'EACCES' });
  } finally {
    await chmod(join(root, 'a'), 0o600);
    await rm(root, { recursive: true, force: true });
  }
});

for (const [mode, expected] of [
  ['missing-hash', 'hash'],
  ['missing-projection-hash', 'projection'],
  ['undeclared-null', 'signals'],
  ['unavailable-false', 'signals'],
] as const)
  test(`${mode} is a protocol error, never an empty snapshot`, async () => {
    const result = await run(mode);
    assert.equal(result.status, 'error', result.message);
    assert.match(result.message, new RegExp(expected, 'i'));
    assert.equal(result.checkpoints.length, 0);
  });

test('legacy SHA-256 cached snapshots detect stale content through runner', async () => {
  const result = await run('stderr', scenarios[0]);
  assert.equal(result.status, 'diverged', result.message);
  assert.equal(result.projection?.hash, 'sha256');
  assert.ok(result.checkpoints[1].differences.some((d) => d.kind === 'content-mismatch'));
});

for (const scenario of scenarios)
  test(`paths applicability is explicit for ${scenario.id}`, async () => {
    const result = await run('paths-frozen', scenario);
    assert.equal(result.checkpoints[0].status, 'match');
    const applicable = ['recreate', 'directory-rename', 'delete'].includes(scenario.id);
    assert.equal(result.status, applicable ? 'diverged' : 'unsupported', result.message);
    assert.equal(
      result.assertions.some((a) => a.checked),
      applicable,
    );
    for (const assertion of result.assertions.filter((a) => !a.checked))
      assert.match(assertion.reason, /content freshness is not checked/);
    assert.equal(result.projection?.hash, 'none');
    assert.ok(
      !result.checkpoints.some((c) => c.differences.some((d) => d.kind === 'content-mismatch')),
    );
  });

test('snapshot exporter failure stays ERROR after matching path baseline', async () => {
  const result = await run('paths-error');
  assert.equal(result.checkpoints[0].status, 'match');
  assert.equal(result.status, 'error');
  assert.match(result.message, /snapshot export failed/);
  assert.equal(result.checkpoints.length, 1);
});

test('unavailable processing/revision is explicit, never an idle assertion or PASS', async () => {
  const result = await run('unavailable');
  assert.equal(result.status, 'inconclusive', result.message);
  assert.equal(result.checkpoints[0].processing, null);
  assert.deepEqual(result.checkpoints[0].differences, []);
  assert.equal(result.checkpoints[1].processing, null);
  assert.ok(result.checkpoints[1].differences.length > 0);
  assert.equal(result.snapshotSignals, 'unavailable');
  assert.ok(result.limitations.some((s) => s.includes('cannot establish idle')));
});

test('JSON and HTML preserve projection, partial assertions and unavailable signals', async () => {
  const result = await run('paths-frozen', scenarios[1]);
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.projection.hash, 'none');
  assert.equal(json.assertions.at(-1).checked, false);
  const html = renderReport(result);
  assert.match(html, /paths and types only; file content is not checked/);
  assert.match(html, /NOT APPLICABLE/);
  assert.match(html, /Write new version/);
  assert.ok(!html.includes('SHA-256 undefined'));
  const unavailable = renderReport(await run('unavailable'));
  assert.match(unavailable, /processing unavailable/);
  assert.match(unavailable, /cannot establish idle convergence or PASS/);
});

test('paths-only real consumer PASS checks changed paths and explicitly omits content freshness', async () => {
  const result = await runScenario({
    command: [
      process.execPath,
      fileURLToPath(new URL('./fixtures/paths-proxy.mjs', import.meta.url)),
    ],
    windowMs: 1800,
    scenario: {
      version: 1,
      id: 'paths-positive',
      name: 'Paths-only positive control',
      description: 'Create, edit content, rename and delete using the existing real consumer.',
      initial: [{ path: 'keep.txt', content: 'keep' }],
      steps: [
        { name: 'Create file', operations: [{ kind: 'write', path: 'new.txt', content: 'a' }] },
        { name: 'Content only', operations: [{ kind: 'write', path: 'new.txt', content: 'b' }] },
        { name: 'Rename file', operations: [{ kind: 'rename', path: 'new.txt', to: 'moved.txt' }] },
        { name: 'Delete file', operations: [{ kind: 'delete', path: 'moved.txt' }] },
      ],
    },
  });
  assert.equal(result.status, 'pass', result.message);
  assert.equal(result.projection?.hash, 'none');
  assert.equal(result.snapshotSignals, 'reported');
  assert.deepEqual(
    result.assertions.map((a) => a.checked),
    [true, false, true, true],
  );
  assert.deepEqual(
    result.checkpoints.map((c) => c.name),
    ['Initial index', 'Create file', 'Rename file', 'Delete file'],
  );
  assert.ok(
    result.checkpoints.every(
      (c) => c.status === 'match' && c.processing === false && !c.differences.length,
    ),
  );
  assert.deepEqual(
    result.checkpoints.map((c) => c.index.map((e) => e.path)),
    [['keep.txt'], ['keep.txt', 'new.txt'], ['keep.txt', 'moved.txt'], ['keep.txt']],
  );
  assert.ok(result.checkpoints.every((c) => c.index.every((e) => !('hash' in e))));
  assert.ok(result.observations.some((o) => o.kind === 'event'));
  assert.match(result.message, /file content is not checked/);
  assert.match(renderReport(result), /NOT APPLICABLE · Content only/);
  assert.equal(result.cleaned, true);
});
