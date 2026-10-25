import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AdapterClient } from '../src/core/protocol.ts';
import { runScenario } from '../src/core/runner.ts';
import { scenarios } from '../src/core/scenarios.ts';

const command = (mode: string) => [
  process.execPath,
  fileURLToPath(new URL('./fixtures/adapter.mjs', import.meta.url)),
  mode,
];

test('JSONL request IDs, snapshots from existing state, stderr logs and graceful cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchconverge-protocol-'));
  const logs: string[] = [];
  const client = new AdapterClient(command('stderr'), root, (_k, m) => logs.push(m));
  try {
    await writeFile(join(root, 'a'), 'before');
    await client.ready(root, 1500);
    const before = await client.snapshot(1000);
    await writeFile(join(root, 'a'), 'after');
    const after = await client.snapshot(1000);
    assert.deepEqual(
      before.entries,
      after.entries,
      'snapshot did not rescan and repair the fixture cache',
    );
    assert.ok(logs.some((m) => m.includes('indexer log')));
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
for (const [mode, status, fragment] of [
  ['no-ready', 'not-ready', 'timed out'],
  ['no-snapshot', 'error', 'timed out'],
  ['invalid-json', 'error', 'JSON'],
  ['bad-version', 'error', 'version'],
  ['bad-id', 'error', 'request ID'],
  ['duplicate', 'error', 'request ID'],
  ['exit', 'error', 'exited'],
  ['snapshot-exit', 'error', 'exited'],
  ['bad-hash', 'error', 'hash'],
  ['regression', 'error', 'backwards'],
  ['oversize', 'error', 'MiB'],
  ['baseline-mismatch', 'not-ready', 'initial index'],
  ['processing', 'not-ready', 'initial index'],
  ['no-stop', 'error', 'cleanup'],
  ['stop-exit', 'error', 'exited \\(7\\)'],
  ['stop-signal', 'error', 'after stop acknowledgment'],
  ['stop-hangs', 'error', 'forced termination'],
] as const) {
  test(`protocol fault ${mode}: ${status}, bounded and cleaned`, async () => {
    const start = performance.now();
    const scenario = ['no-stop', 'stop-exit', 'stop-signal', 'stop-hangs'].includes(mode)
      ? { ...scenarios[0], steps: [{ name: 'No writes', operations: [] }] }
      : scenarios[0];
    const r = await runScenario({
      scenario,
      command: command(mode),
      readyTimeoutMs: mode === 'no-ready' ? 150 : 2000,
      requestTimeoutMs: 150,
      windowMs: 100,
      pollMs: 20,
    });
    assert.equal(r.status, status, r.message);
    assert.match(r.message, new RegExp(fragment, 'i'));
    assert.equal(r.cleaned, true);
    assert.ok(performance.now() - start < 7000);
  });
}
test('missing executable is an infrastructure error and removes the temporary tree', async () => {
  const r = await runScenario({
    scenario: scenarios[0],
    command: [join(tmpdir(), 'watchconverge-nonexistent-executable')],
  });
  assert.equal(r.status, 'error');
  assert.equal(r.cleaned, true);
});
test('stop interrupts readiness without waiting for its deadline', async () => {
  const controller = new AbortController();
  const promise = runScenario({
    scenario: scenarios[0],
    command: command('no-ready'),
    signal: controller.signal,
    readyTimeoutMs: 10000,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  const r = await promise;
  clearTimeout(timer);
  assert.equal(r.status, 'stopped');
  assert.equal(r.cleaned, true);
});
test('stop between requests preserves cancellation while terminating an uncooperative adapter', async () => {
  const controller = new AbortController();
  const r = await runScenario({
    scenario: scenarios[0],
    command: command('no-stop'),
    signal: controller.signal,
    onObservation: (o) => {
      if (o.kind === 'comparison' && o.message.startsWith('Atomic replacement')) controller.abort();
    },
  });
  assert.equal(r.status, 'stopped', r.message);
  assert.equal(r.cleaned, true);
});
test('post-write processing deadline is inconclusive, not a claim of lost events', async () => {
  const r = await runScenario({
    scenario: scenarios[0],
    command: command('late-processing'),
    windowMs: 100,
    pollMs: 20,
  });
  assert.equal(r.status, 'inconclusive', r.message);
  assert.equal(r.checkpoints[0].status, 'match');
  assert.ok(r.checkpoints.slice(1).every((c) => c.processing && c.status === 'inconclusive'));
  assert.equal(r.cleaned, true);
});
test('a matching snapshot after the observation deadline cannot produce PASS', async () => {
  const scenario = { ...scenarios[0], steps: [{ name: 'No writes', operations: [] }] };
  const r = await runScenario({
    scenario,
    command: command('late-response'),
    windowMs: 100,
    requestTimeoutMs: 1000,
  });
  assert.equal(r.status, 'inconclusive', r.message);
  assert.deepEqual(r.checkpoints[1].differences, []);
  assert.equal(r.checkpoints[1].status, 'inconclusive');
});
test('one slow mismatching sample is insufficient to establish persistent divergence', async () => {
  const r = await runScenario({
    scenario: scenarios[0],
    command: command('late-response'),
    windowMs: 100,
    requestTimeoutMs: 1000,
  });
  assert.equal(r.status, 'inconclusive', r.message);
  assert.ok(r.checkpoints[1].differences.length > 0);
  assert.equal(r.checkpoints[1].samples, 1);
});
test('pending-processing samples do not count as repeated idle divergence', async () => {
  const r = await runScenario({
    scenario: scenarios[0],
    command: command('late-idle'),
    windowMs: 100,
    requestTimeoutMs: 1000,
    pollMs: 20,
  });
  assert.equal(r.status, 'inconclusive', r.message);
  assert.equal(r.checkpoints[1].samples, 2);
  assert.equal(r.checkpoints[1].processing, false);
  assert.ok(r.checkpoints[1].differences.length > 0);
});
