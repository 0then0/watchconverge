import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../src/core/model.ts';
import { builtinCommand } from '../src/core/runner.ts';

function cli(args: string[], throughNpm = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const npm = process.env.npm_execpath;
    const command =
      throughNpm && !npm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
    const argv = throughNpm
      ? [...(npm ? [npm] : []), 'run', '--silent', 'cli', '--', ...args]
      : [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args];
    const child = spawn(command, argv, {
      shell: throughNpm && !npm && process.platform === 'win32',
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
test('CLI exports portable artifacts, replays the scenario and preserves machine-readable stdout', async () => {
  const first = await cli(['--scenario', 'directory-rename', '--json', '--export']);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const result = JSON.parse(first.stdout) as RunResult;
  assert.equal(result.status, 'pass');
  const dir = first.stderr.match(/Exports: (.+)/)?.[1];
  assert.ok(dir);
  try {
    const exported = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    assert.equal(exported.id, result.id);
    assert.ok((await readFile(join(dir, 'report.html'), 'utf8')).includes('<h3>Disk</h3>'));
    const replay = await cli([
      '--scenario-file',
      join(dir, 'scenario.json'),
      '--adapter-json',
      JSON.stringify(builtinCommand('fixed')),
      '--json',
    ]);
    assert.equal(replay.code, 0, replay.stderr);
    assert.notEqual(JSON.parse(replay.stdout).root, result.root);
    assert.ok(result.root);
    await assert.rejects(lstat(result.root), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI rejects unsafe scenario selection and options', async () => {
  assert.equal((await cli(['--scenario', 'not-there'])).code, 2);
  assert.equal((await cli(['--window-ms', '-1'])).code, 2);
  assert.equal((await cli(['--adapter-json', '"not argv"'])).code, 2);
});
test('CLI prints path scope and content-only inapplicability without a misleading PASS', async () => {
  const result = await cli([
    '--scenario',
    'burst',
    '--adapter-json',
    JSON.stringify([
      process.execPath,
      fileURLToPath(new URL('./fixtures/adapter.mjs', import.meta.url)),
      'paths-frozen',
    ]),
  ]);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /Projection:.*paths and types only; file content is not checked/);
  assert.match(result.stdout, /NOT APPLICABLE: 20 overwrites/);
  assert.match(result.stdout, /UNSUPPORTED:/);
});
test('documented npm command emits only JSON and preserves the divergence exit code', async () => {
  const passed = await cli(['--scenario', 'delete', '--json'], true);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal((JSON.parse(passed.stdout) as RunResult).status, 'pass');
  if (process.platform !== 'win32') {
    const diverged = await cli(
      ['--scenario', 'atomic-save', '--adapter', 'broken', '--window-ms', '300', '--json'],
      true,
    );
    assert.equal(diverged.code, 1, diverged.stderr);
    assert.equal((JSON.parse(diverged.stdout) as RunResult).status, 'diverged');
  }
});
