import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { test } from 'node:test';
import { renderReport } from '../src/core/report.ts';
import { runScenario } from '../src/core/runner.ts';
import { scenarios } from '../src/core/scenarios.ts';

for (const scenario of scenarios)
  test(`real fixed fs.watch consumer: ${scenario.id}`, async () => {
    const result = await runScenario({ scenario, adapter: 'fixed', windowMs: 1800 });
    assert.equal(result.status, 'pass', result.message);
    assert.ok(result.observations.some((o) => o.kind === 'event'));
    assert.ok(result.observations.some((o) => o.kind === 'processed'));
    assert.equal(result.checkpoints.length, scenario.steps.length + 1);
    assert.ok(result.checkpoints.every((c) => !c.processing && !c.differences.length));
    assert.equal(result.cleaned, true);
    assert.ok(result.root);
    await assert.rejects(lstat(result.root), { code: 'ENOENT' });
  });
test('real file subscription stays on original inode after atomic save', {
  skip: !['linux', 'darwin'].includes(process.platform)
    ? 'UNSUPPORTED: inode demonstration requires Linux/macOS, not PASS'
    : false,
}, async () => {
  const result = await runScenario({ scenario: scenarios[0], adapter: 'broken', windowMs: 500 });
  assert.equal(result.status, 'diverged', result.message);
  assert.equal(
    result.checkpoints[1].status,
    'match',
    'replacement notification updates v1 before the next write',
  );
  assert.ok(
    result.checkpoints[2].differences.some(
      (d) => d.kind === 'content-mismatch' && d.path === 'app.txt',
    ),
  );
  assert.ok(result.checkpoints[2].samples > 1);
  assert.equal(result.cleaned, true);
});
test('unsupported inode example is explicitly unsupported on Windows', {
  skip: process.platform === 'win32' ? false : 'Windows-only unsupported-result contract',
}, async () => {
  const result = await runScenario({ scenario: scenarios[0], adapter: 'broken' });
  assert.equal(result.status, 'unsupported');
  assert.notEqual(result.status, 'pass');
});
test('rerun creates a fresh tree and report escapes all consumer-controlled text', async () => {
  const a = await runScenario({ scenario: scenarios[4] });
  const b = await runScenario({ scenario: scenarios[4] });
  assert.equal(a.status, 'pass', a.message);
  assert.equal(b.status, 'pass', b.message);
  assert.notEqual(a.root, b.root);
  a.message = '<script>alert("x")</script>';
  const html = renderReport(a);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(!/\b(?:src|href)="https?:/.test(html));
  assert.ok(html.includes('Replayable scenario JSON'));
  assert.ok(html.includes('Complete result JSON'));
});
