import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { compare } from '../src/core/compare.ts';
import {
  DEFAULT_PROJECTION,
  type Entry,
  type Operation,
  type RunResult,
  type Scenario,
} from '../src/core/model.ts';
import {
  classifyRun,
  type Reduction,
  reduceScenario,
  selectTarget,
  writeReduction,
} from '../src/core/reduce.ts';
import { runScenario } from '../src/core/runner.ts';
import { parseScenario } from '../src/core/scenarios.ts';

type Step = Scenario['steps'][number];
const write = (path: string, content: string, name = 'Edit'): Step => ({
  name,
  operations: [{ kind: 'write', path, content }],
});
const atomic = (path: string, content: string, name = 'Edit'): Step => ({
  name,
  operations: [{ kind: 'atomic', path, content }],
});
function scenarioOf(steps: Step[], initial: Record<string, string> = {}): Scenario {
  return {
    version: 1,
    id: 'case',
    name: 'Case',
    description: 'Reducer test case',
    initial: Object.entries({ 'a.txt': 'a0', 'b.txt': 'b0', 'noise.txt': 'n0', ...initial }).map(
      ([path, content]) => ({ path, content }),
    ),
    steps,
  };
}
const entries = (files: Map<string, string>): Entry[] =>
  [...files]
    .map(
      ([path, content]): Entry => ({
        path,
        type: 'file',
        hash: createHash('sha256').update(content).digest('hex'),
      }),
    )
    .sort((x, y) => (x.path < y.path ? -1 : 1));

/**
 * Deterministic in-memory stand-in for runner + adapter. Disk follows every operation; the index
 * follows it too unless `misses` says the consumer does not see that operation. Checkpoints are
 * built with the real comparison, and a missing rename/delete source fails like the runner does.
 */
function evaluator(
  misses: (op: Operation, earlier: Operation[]) => boolean,
  intercept?: (
    call: number,
    scenario: Scenario,
    result: RunResult,
  ) => RunResult | Promise<RunResult>,
) {
  const calls: number[] = [];
  const execute = async (scenario: Scenario): Promise<RunResult> => {
    const disk = new Map(scenario.initial.map((f) => [f.path, f.content]));
    const index = new Map(disk);
    const earlier: Operation[] = [];
    const result: RunResult = {
      version: 1,
      id: `run-${calls.length}`,
      scenario,
      adapter: ['fake'],
      platform: 'test',
      node: process.version,
      startedAt: new Date().toISOString(),
      status: 'pass',
      message: '',
      projection: DEFAULT_PROJECTION,
      limitations: [],
      assertions: [],
      options: { windowMs: 100, requestTimeoutMs: 50, readyTimeoutMs: 50, pollMs: 10 },
      cleaned: true,
      checkpoints: [],
      observations: [],
    };
    calls.push(scenario.steps.length);
    run: for (const [step, { name, operations }] of scenario.steps.entries()) {
      for (const [operation, op] of operations.entries()) {
        for (const [files, apply] of [
          [disk, true],
          [index, !misses(op, earlier)],
        ] as const) {
          if (op.kind === 'write' || op.kind === 'atomic') {
            if (apply) files.set(op.path, op.content);
          } else if (!disk.has(op.path) && files === disk) {
            result.status = 'error';
            result.message = 'no such file';
            result.failure = { kind: 'operation', step, operation, code: 'ENOENT' };
            break run;
          } else if (apply) {
            const content = files.get(op.path);
            files.delete(op.path);
            if (op.kind === 'rename' && content !== undefined) files.set(op.to, content);
          }
        }
        earlier.push(op);
      }
      const differences = compare(entries(disk), entries(index));
      result.checkpoints.push({
        id: `c${step}`,
        name,
        step,
        status: differences.length ? 'diverged' : 'match',
        observedMs: 1,
        samples: 2,
        revision: step,
        processing: false,
        disk: entries(disk),
        index: entries(index),
        differences,
        skipped: [],
      });
      if (differences.length) result.status = 'diverged';
    }
    return intercept ? intercept(calls.length, scenario, result) : result;
  };
  return { execute, calls };
}
/** The stale-subscription model: writes after an atomic replacement of the same path are missed. */
const staleAfterAtomic = (op: Operation, earlier: Operation[]) =>
  op.kind === 'write' && earlier.some((e) => e.kind === 'atomic' && e.path === op.path);
const candidates = (r: Reduction) => r.journal.attempts.filter((a) => a.phase === 'candidate');

test('removes unrelated steps, keeps the target and counts every execution', async () => {
  const steps = [
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    write('noise.txt', 'n2'),
    write('a.txt', 'a2'),
    write('noise.txt', 'n3'),
  ];
  const scenario = scenarioOf(steps);
  const before = JSON.stringify(scenario);
  const { execute, calls } = evaluator(staleAfterAtomic);
  const r = await reduceScenario({ scenario, execute });
  assert.equal(r.journal.status, 'reduced', r.journal.message);
  assert.equal(r.journal.stop, 'complete');
  assert.deepEqual(r.journal.steps.kept, [1, 3]);
  assert.equal(r.journal.verification, 'control-reproduced');
  assert.deepEqual(
    { step: r.journal.target?.step, path: r.journal.target?.path, kind: r.journal.target?.kind },
    { step: 3, path: 'a.txt', kind: 'content-mismatch' },
  );
  assert.deepEqual(r.scenario?.steps, [steps[1], steps[3]]);
  assert.deepEqual(r.scenario?.initial, scenario.initial);
  assert.equal(JSON.stringify(scenario), before, 'input scenario object is not mutated');
  assert.deepEqual(r.journal.executions, {
    baseline: 2,
    candidate: candidates(r).length,
    control: 1,
  });
  assert.equal(calls.length, r.journal.attempts.length);
  assert.equal(r.control?.status, 'diverged');
  assert.deepEqual(r.journal.attempts.at(-1)?.kept, [1, 3]);
});

test('repeated step names and identical steps are tracked by original position', async () => {
  const steps = [atomic('a.txt', 'a1'), write('a.txt', 'a2'), write('a.txt', 'a2')];
  const { execute } = evaluator(staleAfterAtomic);
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.target?.step, 1);
  assert.equal(r.journal.target?.stepName, 'Edit');
  assert.deepEqual(r.journal.steps.kept, [0, 1]);
  assert.deepEqual(r.journal.steps.names, ['Edit', 'Edit']);
});

test('a different mismatch on another path at the target checkpoint is not accepted', async () => {
  // Without step 0 the target checkpoint still diverges, but only on b.txt.
  const steps = [
    atomic('a.txt', 'a1'),
    atomic('b.txt', 'b1'),
    {
      name: 'Edit',
      operations: [
        { kind: 'write', path: 'a.txt', content: 'a2' },
        { kind: 'write', path: 'b.txt', content: 'b2' },
      ],
    } satisfies Step,
    write('noise.txt', 'n1'),
  ];
  const { execute } = evaluator(staleAfterAtomic);
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.target?.path, 'a.txt');
  assert.deepEqual(r.journal.steps.kept, [0, 2]);
  const other = candidates(r).filter((a) => a.detail === 'different-divergence');
  assert.ok(other.length > 0);
  assert.ok(other.every((a) => a.outcome === 'no-target' && a.runStatus === 'diverged'));
});

test('a divergence at an earlier checkpoint or of another kind does not stand in for the target', async () => {
  const { execute } = evaluator(staleAfterAtomic);
  const steps = [atomic('a.txt', 'a1'), write('a.txt', 'a2'), write('a.txt', 'a3')];
  const baseline = await execute(scenarioOf(steps));
  const target = selectTarget(baseline);
  assert.ok(target);
  assert.equal(classifyRun(baseline, target, 1).outcome, 'target');
  // The same run judged at a later position: the path diverges there against other content.
  assert.equal(classifyRun(baseline, target, 2).detail, 'expected-disk-state-changed');
  const earlier = structuredClone(baseline);
  earlier.checkpoints[1].status = 'match';
  earlier.checkpoints[1].differences = [];
  earlier.checkpoints[0].status = 'diverged';
  earlier.checkpoints[0].differences = baseline.checkpoints[1].differences;
  assert.deepEqual(classifyRun(earlier, target, 1), {
    outcome: 'no-target',
    detail: 'target-checkpoint-match',
  });
  const kind = structuredClone(baseline);
  kind.checkpoints[1].differences[0].kind = 'type-mismatch';
  assert.equal(classifyRun(kind, target, 1).outcome, 'no-target');
  for (const status of ['inconclusive', 'not-ready', 'unsupported'] as const)
    assert.equal(classifyRun({ ...baseline, status }, target, 1).outcome, 'incomplete');
  assert.equal(classifyRun({ ...baseline, status: 'pass' }, target, 1).outcome, 'no-target');
  const error = { ...baseline, status: 'error' as const };
  assert.equal(classifyRun(error, target, 1).outcome, 'infrastructure-error');
  assert.equal(
    classifyRun({ ...error, failure: { kind: 'adapter', code: 'request-timeout' } }, target, 1)
      .outcome,
    'incomplete',
  );
  assert.equal(
    classifyRun(
      { ...error, failure: { kind: 'operation', step: 0, operation: 0, code: 'EACCES' } },
      target,
      1,
    ).outcome,
    'infrastructure-error',
  );
});

test('a removal that changes the expected disk state of the target path is rejected', async () => {
  // The consumer misses renames. Without step 0 the rename still works and a.txt still has a
  // content mismatch, but against different disk content than in the baseline.
  const steps = [
    write('src.txt', 'one'),
    { name: 'Move', operations: [{ kind: 'rename', path: 'src.txt', to: 'a.txt' }] } satisfies Step,
  ];
  const { execute } = evaluator((op) => op.kind === 'rename');
  const r = await reduceScenario({ scenario: scenarioOf(steps, { 'src.txt': 'zero' }), execute });
  assert.equal(r.journal.target?.kind, 'content-mismatch');
  assert.equal(r.journal.status, 'unchanged', r.journal.message);
  assert.deepEqual(r.journal.steps.kept, [0, 1]);
  assert.deepEqual(
    candidates(r).map((a) => [a.kept, a.outcome, a.detail]),
    [[[1], 'no-target', 'expected-disk-state-changed']],
  );
});

test('candidates with an impossible rename or delete are invalid, not evidence of a fix', async () => {
  const steps = [
    write('tmp.txt', 't'),
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    { name: 'Move', operations: [{ kind: 'rename', path: 'tmp.txt', to: 'x.txt' }] } satisfies Step,
    write('a.txt', 'a2'),
    { name: 'Drop', operations: [{ kind: 'delete', path: 'x.txt' }] } satisfies Step,
  ];
  const { execute } = evaluator(staleAfterAtomic);
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.status, 'reduced', r.journal.message);
  assert.deepEqual(r.journal.steps.kept, [2, 4]);
  const invalid = candidates(r).filter((a) => a.outcome === 'invalid-sequence');
  assert.ok(invalid.length > 0);
  for (const a of invalid) {
    assert.equal(a.runStatus, 'error');
    assert.equal(a.failure?.kind, 'operation');
    // Each invalid candidate cost exactly one execution and was never confirmed or retried.
    assert.equal(candidates(r).filter((b) => String(b.kept) === String(a.kept)).length, 1);
  }
});

test('an unstable baseline ends as not reproducible without a scenario', async () => {
  const steps = [atomic('a.txt', 'a1'), write('a.txt', 'a2'), write('noise.txt', 'n1')];
  const { execute, calls } = evaluator(staleAfterAtomic, (call, _s, result) =>
    call === 2 ? { ...result, status: 'pass' } : result,
  );
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.status, 'not-reproducible');
  assert.equal(r.journal.stop, 'baseline-not-reproducible');
  assert.equal(r.journal.verification, 'none');
  assert.equal(r.scenario, undefined);
  assert.deepEqual(r.journal.files, { scenario: null, control: null });
  assert.deepEqual(r.journal.executions, { baseline: 2, candidate: 0, control: 0 });
  assert.equal(calls.length, 2);
  assert.ok(r.journal.target, 'the selected target stays in the journal');
});

test('unstable or inconclusive candidates are rejected once and never retried', async () => {
  const steps = [
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    write('a.txt', 'a2'),
    write('noise.txt', 'n2'),
  ];
  // Every shortened scenario reproduces on its first run and is inconclusive afterwards.
  const seen = new Set<string>();
  const { execute } = evaluator(staleAfterAtomic, (_call, scenario, result) => {
    const key = JSON.stringify(scenario.steps);
    if (scenario.steps.length === steps.length || !seen.has(key)) {
      seen.add(key);
      return result;
    }
    return { ...result, status: 'inconclusive' };
  });
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.status, 'unchanged', r.journal.message);
  assert.deepEqual(r.journal.steps.kept, [0, 1, 2, 3]);
  const perCandidate = new Map<string, string[]>();
  for (const a of candidates(r))
    perCandidate.set(String(a.kept), [...(perCandidate.get(String(a.kept)) ?? []), a.outcome]);
  assert.ok(perCandidate.size > 1);
  for (const outcomes of perCandidate.values()) assert.ok(outcomes.length <= 2, String(outcomes));
  assert.ok([...perCandidate.values()].some((o) => String(o) === 'target,incomplete'));
  assert.ok(candidates(r).length <= 40);
});

test('the candidate execution budget is exact and keeps the best confirmed scenario', async () => {
  const steps = [
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    write('noise.txt', 'n2'),
    write('a.txt', 'a2'),
    write('noise.txt', 'n3'),
  ];
  const full = await reduceScenario({
    scenario: scenarioOf(steps),
    execute: evaluator(staleAfterAtomic).execute,
  });
  const needed = full.journal.executions.candidate;
  assert.ok(needed > 4);
  for (const maxExecutions of [1, 2, 3, 4, needed - 1]) {
    const { execute, calls } = evaluator(staleAfterAtomic);
    const r = await reduceScenario({ scenario: scenarioOf(steps), execute, maxExecutions });
    assert.equal(r.journal.status, 'budget-exhausted', `${maxExecutions}: ${r.journal.message}`);
    assert.equal(r.journal.stop, 'budget');
    assert.ok(r.journal.executions.candidate <= maxExecutions);
    // Same deterministic prefix of the unlimited search, cut where the budget ends.
    assert.deepEqual(
      candidates(r).map((a) => a.kept),
      candidates(full)
        .map((a) => a.kept)
        .slice(0, r.journal.executions.candidate),
    );
    assert.equal(calls.length, 2 + r.journal.executions.candidate + 1);
    assert.equal(r.journal.verification, 'control-reproduced');
    // The written scenario is one that reproduced twice, never a half-tested candidate.
    const kept = r.journal.steps.kept;
    const confirmations = candidates(r).filter(
      (a) => String(a.kept) === String(kept) && a.outcome === 'target',
    ).length;
    assert.ok(kept.length === steps.length || confirmations === 2);
    assert.deepEqual(r.journal.attempts.at(-1)?.kept, kept);
  }
  const { execute } = evaluator(staleAfterAtomic);
  const three = await reduceScenario({ scenario: scenarioOf(steps), execute, maxExecutions: 4 });
  assert.equal(three.journal.executions.candidate, 4);
  assert.deepEqual(three.journal.steps.kept, [0, 1, 3]);
  await assert.rejects(reduceScenario({ scenario: scenarioOf(steps), execute, maxExecutions: 0 }));
});

test('deadline stops the search, keeps the confirmed scenario and runs no control', async () => {
  const steps = [
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    write('noise.txt', 'n2'),
    write('a.txt', 'a2'),
  ];
  const { execute } = evaluator(staleAfterAtomic);
  let call = 0;
  const r = await reduceScenario({
    scenario: scenarioOf(steps),
    deadlineMs: 150,
    execute: async (scenario, signal) => {
      const result = await execute(scenario);
      if (++call <= 2) return result;
      // Like the runner: an aborted execution reports STOPPED instead of a verdict.
      return delay(100, undefined, { signal }).then(
        () => result,
        () => ({ ...result, status: 'stopped' as const }),
      );
    },
  });
  assert.equal(r.journal.status, 'deadline-exceeded', r.journal.message);
  assert.equal(r.journal.stop, 'deadline');
  assert.equal(r.journal.executions.control, 0);
  assert.equal(r.control, undefined);
  assert.equal(r.journal.verification, 'confirmed-without-control');
  assert.equal(r.journal.attempts.at(-1)?.outcome, 'cancelled');
  assert.deepEqual(r.scenario?.steps, steps, 'nothing was confirmed twice before the deadline');
});

test('cancellation keeps the last confirmed candidate with an honest verification status', async () => {
  const steps = [
    write('noise.txt', 'n1'),
    atomic('a.txt', 'a1'),
    write('noise.txt', 'n2'),
    write('a.txt', 'a2'),
    write('noise.txt', 'n3'),
  ];
  const controller = new AbortController();
  // Calls 1-2 baseline, 3-4 rejected candidates, 5-6 confirm [0,1,3]; cancel during call 7.
  const { execute, calls } = evaluator(staleAfterAtomic, (call, _s, result) => {
    if (call !== 7) return result;
    controller.abort();
    return { ...result, status: 'stopped' };
  });
  const r = await reduceScenario({
    scenario: scenarioOf(steps),
    execute,
    signal: controller.signal,
  });
  assert.equal(r.journal.status, 'cancelled', r.journal.message);
  assert.equal(calls.length, 7, 'no execution starts after cancellation');
  assert.deepEqual(r.journal.steps.kept, [0, 1, 3]);
  assert.deepEqual(r.scenario?.steps, [steps[0], steps[1], steps[3]]);
  assert.equal(r.journal.verification, 'confirmed-without-control');
  assert.deepEqual(r.journal.files, { scenario: 'scenario.json', control: null });

  const aborted = new AbortController();
  aborted.abort();
  const early = await reduceScenario({
    scenario: scenarioOf(steps),
    execute: evaluator(staleAfterAtomic).execute,
    signal: aborted.signal,
  });
  assert.equal(early.journal.status, 'cancelled');
  assert.equal(early.journal.attempts.length, 0);
  assert.equal(early.scenario, undefined);
});

test('a control replay stopped by cancellation is not reported as a failed control', async () => {
  const steps = [write('noise.txt', 'n1'), atomic('a.txt', 'a1'), write('a.txt', 'a2')];
  const controller = new AbortController();
  // Calls 1-2 baseline, 3 rejects [2], 4-5 confirm [1,2], 6 is the control replay.
  const { execute, calls } = evaluator(staleAfterAtomic, (call, _s, result) => {
    if (call !== 6) return result;
    controller.abort();
    return { ...result, status: 'stopped' };
  });
  const r = await reduceScenario({
    scenario: scenarioOf(steps),
    execute,
    signal: controller.signal,
  });
  assert.equal(calls.length, 6);
  assert.deepEqual(r.journal.attempts.at(-1)?.phase, 'control');
  assert.equal(r.journal.status, 'cancelled', r.journal.message);
  assert.deepEqual(r.journal.steps.kept, [1, 2]);
  assert.equal(r.journal.verification, 'confirmed-without-control');
  assert.equal(r.control, undefined);
  assert.deepEqual(r.journal.files, { scenario: 'scenario.json', control: null });
});

test('settings the runner rejects are a usage error, not a recorded attempt', async () => {
  await assert.rejects(
    reduceScenario({ scenario: scenarioOf([write('a.txt', 'a1')]), run: { windowMs: -1 } }),
    /Deadline must be an integer/,
  );
});

test('repeated infrastructure errors stop the search instead of consuming the budget', async () => {
  const steps = [atomic('a.txt', 'a1'), write('noise.txt', 'n1'), write('a.txt', 'a2')];
  const { execute } = evaluator(staleAfterAtomic, (call, _s, result) =>
    call > 2 ? { ...result, status: 'error', failure: { kind: 'adapter', code: 'exit' } } : result,
  );
  const r = await reduceScenario({ scenario: scenarioOf(steps), execute });
  assert.equal(r.journal.status, 'infrastructure-error', r.journal.message);
  assert.equal(r.journal.executions.candidate, 3);
  assert.equal(r.journal.executions.control, 0);
  assert.deepEqual(r.scenario?.steps, steps);
});

test('artifacts replay through the normal parser, never overwrite and leave no partial output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchconverge-reduce-test-'));
  try {
    const steps = [write('noise.txt', 'n1'), atomic('a.txt', 'a1'), write('a.txt', 'a2')];
    const r = await reduceScenario({
      scenario: scenarioOf(steps),
      execute: evaluator(staleAfterAtomic).execute,
    });
    const out = join(directory, 'out');
    await writeReduction(out, r);
    assert.deepEqual((await readdir(directory)).sort(), ['out']);
    assert.deepEqual((await readdir(out)).sort(), [
      'control.json',
      'reduction.json',
      'scenario.json',
    ]);
    const exported = parseScenario(JSON.parse(await readFile(join(out, 'scenario.json'), 'utf8')));
    assert.deepEqual(exported.steps, [steps[1], steps[2]]);
    const journal = JSON.parse(await readFile(join(out, 'reduction.json'), 'utf8'));
    assert.deepEqual(journal, JSON.parse(JSON.stringify(r.journal)));
    assert.equal(JSON.parse(await readFile(join(out, 'control.json'), 'utf8')).status, 'diverged');

    const before = await readFile(join(out, 'reduction.json'), 'utf8');
    await assert.rejects(writeReduction(out, r), /already exists/);
    const empty = join(directory, 'empty');
    await mkdir(empty);
    await assert.rejects(writeReduction(empty, r), /already exists/);
    const file = join(directory, 'file');
    await writeFile(file, 'keep');
    await assert.rejects(writeReduction(file, r), /already exists/);
    assert.equal(await readFile(file, 'utf8'), 'keep');
    assert.equal(await readFile(join(out, 'reduction.json'), 'utf8'), before);
    assert.deepEqual((await readdir(directory)).sort(), ['empty', 'file', 'out']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner reports step positions and a typed operation failure', async () => {
  const result = await runScenario({
    adapter: 'fixed',
    windowMs: 1800,
    scenario: {
      ...scenarioOf([
        write('noise.txt', 'n1', 'Same'),
        { name: 'Same', operations: [{ kind: 'rename', path: 'absent.txt', to: 'x.txt' }] },
      ]),
    },
  });
  assert.equal(result.status, 'error', result.message);
  assert.deepEqual(result.failure, { kind: 'operation', step: 1, operation: 0, code: 'ENOENT' });
  assert.deepEqual(
    result.checkpoints.map((c) => c.step),
    [undefined, 0],
  );
  assert.equal(result.cleaned, true);
});

// Real CLI → runner → adapter → filesystem path.
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      ...args,
    ]);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
// Every step writes an existing file, so the only stale path is the replaced app.txt.
const real: Scenario = {
  version: 1,
  id: 'stale-long',
  name: 'Stale index with unrelated edits',
  description: 'Independent edits around an atomic replacement and a later write.',
  initial: [
    { path: 'app.txt', content: 'v0\n' },
    { path: 'other.txt', content: 'o0\n' },
    { path: 'dir/keep.txt', content: 'k0\n' },
  ],
  steps: [
    write('other.txt', 'o1\n'),
    write('dir/keep.txt', 'k1\n'),
    write('app.txt', 'v0b\n'),
    atomic('app.txt', 'v1\n', 'Atomic replacement'),
    write('other.txt', 'o2\n'),
    write('app.txt', 'v2\n'),
    write('dir/keep.txt', 'k2\n'),
    write('other.txt', 'o3\n'),
  ],
};

test('CLI reduces a real stale-index scenario and the result replays as DIVERGED', {
  skip: !['linux', 'darwin'].includes(process.platform)
    ? 'UNSUPPORTED: inode demonstration requires Linux/macOS, not PASS'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchconverge-reduce-cli-'));
  try {
    const input = join(directory, 'scenario.json');
    const source = JSON.stringify(real, null, 2);
    await writeFile(input, source);
    const out = join(directory, 'reduced');
    const args = ['reduce', '--scenario-file', input, '--adapter', 'broken', '--window-ms', '500'];
    const reduced = await cli([...args, '--out', out, '--json']);
    assert.equal(reduced.code, 0, reduced.stderr + reduced.stdout);
    const journal = JSON.parse(reduced.stdout) as Reduction['journal'];
    assert.equal(journal.status, 'reduced');
    assert.equal(journal.verification, 'control-reproduced');
    assert.deepEqual(
      [journal.target?.step, journal.target?.path, journal.target?.kind],
      [5, 'app.txt', 'content-mismatch'],
    );
    assert.ok(journal.steps.kept.includes(3) && journal.steps.kept.includes(5));
    assert.ok(journal.steps.kept.length < real.steps.length);
    assert.deepEqual(journal.executions.baseline, 2);
    assert.ok(journal.executions.candidate <= 40);
    assert.equal(journal.settings.observation?.windowMs, 500);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'reduction.json'), 'utf8')), journal);
    const exported = JSON.parse(await readFile(join(out, 'scenario.json'), 'utf8')) as Scenario;
    assert.deepEqual(
      exported.steps,
      journal.steps.kept.map((i) => real.steps[i]),
    );
    assert.deepEqual(exported.initial, real.initial);
    const control = JSON.parse(await readFile(join(out, 'control.json'), 'utf8')) as RunResult;
    assert.equal(control.status, 'diverged');
    assert.deepEqual(control.scenario, exported);

    const replay = await cli([
      '--scenario-file',
      join(out, 'scenario.json'),
      '--adapter',
      'broken',
      '--window-ms',
      '500',
      '--json',
    ]);
    assert.equal(replay.code, 1, replay.stderr);
    const replayed = JSON.parse(replay.stdout) as RunResult;
    assert.ok(
      replayed.checkpoints
        .at(-1)
        ?.differences.some((d) => d.path === 'app.txt' && d.kind === 'content-mismatch'),
    );

    assert.equal(await readFile(input, 'utf8'), source, 'input file is unchanged');
    const again = await cli([...args, '--out', out]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already exists/);
    assert.doesNotMatch(again.stderr, /baseline/, 'no execution is spent on a refused output');
    assert.deepEqual(JSON.parse(await readFile(join(out, 'reduction.json'), 'utf8')), journal);
    assert.deepEqual((await readdir(directory)).sort(), ['reduced', 'scenario.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI reduce with the fixed consumer reports no reproducible target and writes no scenario', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchconverge-reduce-cli-'));
  try {
    const input = join(directory, 'scenario.json');
    await writeFile(input, JSON.stringify(real));
    const out = join(directory, 'fixed');
    const result = await cli([
      'reduce',
      '--scenario-file',
      input,
      '--adapter',
      'fixed',
      '--window-ms',
      '1800',
      '--out',
      out,
    ]);
    assert.equal(result.code, 2, result.stderr + result.stdout);
    assert.match(result.stdout, /NOT-REPRODUCIBLE/);
    assert.deepEqual(await readdir(out), ['reduction.json']);
    const journal = JSON.parse(await readFile(join(out, 'reduction.json'), 'utf8'));
    assert.equal(journal.status, 'not-reproducible');
    assert.equal(journal.target, null);
    assert.deepEqual(journal.executions, { baseline: 1, candidate: 0, control: 0 });
    assert.equal(journal.attempts[0].runStatus, 'pass');
    assert.equal((await cli(['reduce', '--scenario-file', input])).code, 2, '--out is required');
    assert.equal((await cli(['--out', out])).code, 2, '--out needs the reduce command');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
