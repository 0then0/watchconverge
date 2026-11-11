import { lstat, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Difference, Entry, Projection, RunFailure, RunResult, Scenario } from './model.ts';
import { type RunOptions, runScenario } from './runner.ts';
import { parseScenario } from './scenarios.ts';

/**
 * Identity of the divergence a reduction must preserve. It consists of exactly these fields
 * (`stepName` is a label only): the original zero-based step position, the relative path, the
 * difference kind, the expected disk entry for that path under the projection, and the projection
 * itself. Run UUIDs, timestamps, sample counts and the stale index value are not part of it.
 */
export interface ReductionTarget {
  step: number;
  stepName: string;
  path: string;
  kind: Difference['kind'];
  /** Disk entry for `path` at the target checkpoint; null when the path is absent on disk. */
  disk: Entry | null;
  projection: Projection;
}
export type AttemptOutcome =
  /** DIVERGED run whose target checkpoint shows the target difference. */
  | 'target'
  /** Complete, valid observation without the target. */
  | 'no-target'
  /** A remaining operation could not be applied to the tree left by the kept steps. */
  | 'invalid-sequence'
  /** INCONCLUSIVE, NOT-READY, UNSUPPORTED or a timeout: neither presence nor absence is shown. */
  | 'incomplete'
  | 'infrastructure-error'
  | 'cancelled';
export interface Attempt {
  seq: number;
  phase: 'baseline' | 'candidate' | 'control';
  /** Original zero-based positions of the steps that were executed, in order. */
  kept: number[];
  outcome: AttemptOutcome;
  detail: string;
  runStatus: RunResult['status'] | null;
  failure?: RunFailure;
  durationMs: number;
}
export type StopReason =
  | 'complete'
  | 'budget'
  | 'deadline'
  | 'cancelled'
  | 'baseline-not-reproducible'
  | 'infrastructure-error';
export type ReductionStatus =
  | 'reduced'
  | 'unchanged'
  | 'budget-exhausted'
  | 'deadline-exceeded'
  | 'not-reproducible'
  | 'cancelled'
  | 'infrastructure-error';
export interface ReductionJournal {
  version: 1;
  status: ReductionStatus;
  stop: StopReason;
  message: string;
  settings: {
    adapter: string[] | null;
    observation: RunResult['options'] | null;
    maxExecutions: number;
    deadlineMs: number;
  };
  target: ReductionTarget | null;
  steps: { original: number; kept: number[]; names: string[] };
  /**
   * How far the written scenario is verified: `control-reproduced` (independent control replay),
   * `confirmed-without-control` (two reproductions, control not run), `control-not-reproduced`,
   * or `none` when no scenario was confirmed and none is written.
   */
  verification:
    | 'control-reproduced'
    | 'confirmed-without-control'
    | 'control-not-reproduced'
    | 'none';
  executions: { baseline: number; candidate: number; control: number };
  files: { scenario: 'scenario.json' | null; control: 'control.json' | null };
  attempts: Attempt[];
}
export interface Reduction {
  journal: ReductionJournal;
  /** Last confirmed scenario; absent when the baseline target was never confirmed. */
  scenario?: Scenario;
  /** Result of the independent control replay, when it ran. */
  control?: RunResult;
}
export interface ReduceOptions {
  scenario: Scenario;
  /** Adapter and observation settings, passed unchanged to every execution. */
  run?: Omit<RunOptions, 'scenario' | 'signal'>;
  /** Maximum candidate executions, confirmations included. Baseline and control are separate. */
  maxExecutions?: number;
  /** Overall deadline for baseline, search and control. */
  deadlineMs?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: Attempt) => void;
  /** Replaces the runner in algorithm tests. Each call must be an independent execution. */
  execute?: (scenario: Scenario, signal: AbortSignal) => Promise<RunResult>;
}

/** Errno codes that describe the shape of the tree rather than the health of the host. */
const SEQUENCE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EEXIST']);
const INFRASTRUCTURE_LIMIT = 3;
const sorted = (values: string[]) => [...values].sort();
const sameProjection = (a: Projection | undefined, b: Projection) =>
  a !== undefined &&
  a.paths === b.paths &&
  a.hash === b.hash &&
  JSON.stringify(sorted(a.types)) === JSON.stringify(sorted(b.types)) &&
  JSON.stringify(sorted(a.excludes)) === JSON.stringify(sorted(b.excludes));
const sameEntry = (a: Entry | null, b: Entry | null) =>
  a === null || b === null
    ? a === b
    : a.type === b.type &&
      (a.type === 'file' ? a.hash : undefined) === (b.type === 'file' ? b.hash : undefined);
type Verdict = { outcome: AttemptOutcome; detail: string };

/** Outcomes that do not depend on a target. Returns undefined for PASS and DIVERGED. */
function classifyFailure(result: RunResult): Verdict | undefined {
  if (result.status === 'pass' || result.status === 'diverged') return undefined;
  if (result.status === 'stopped') return { outcome: 'cancelled', detail: 'stopped' };
  const failure = result.failure;
  if (result.status !== 'error') {
    const timeout = failure?.kind === 'adapter' && failure.code === 'ready-timeout';
    return { outcome: 'incomplete', detail: timeout ? 'ready-timeout' : result.status };
  }
  if (failure?.kind === 'operation' && failure.code !== null && SEQUENCE_CODES.has(failure.code))
    return {
      outcome: 'invalid-sequence',
      detail: `step ${failure.step} operation ${failure.operation}: ${failure.code}`,
    };
  if (failure?.kind === 'deadline') return { outcome: 'incomplete', detail: 'run-deadline' };
  if (failure?.kind === 'adapter' && failure.code === 'request-timeout')
    return { outcome: 'incomplete', detail: 'request-timeout' };
  return {
    outcome: 'infrastructure-error',
    detail:
      failure?.kind === 'operation'
        ? `operation: ${failure.code ?? 'unknown'}`
        : failure?.kind === 'adapter'
          ? `adapter: ${failure.code}`
          : (failure?.kind ?? 'unclassified'),
  };
}

/**
 * Decide whether a run reproduces the target. `position` is the target step's index within the
 * executed scenario. Only a DIVERGED run whose target checkpoint is itself DIVERGED, has the
 * baseline's expected disk entry for the path and reports the same difference kind there counts.
 */
export function classifyRun(result: RunResult, target: ReductionTarget, position: number): Verdict {
  const failure = classifyFailure(result);
  if (failure) return failure;
  if (result.status === 'pass') return { outcome: 'no-target', detail: 'pass' };
  if (!sameProjection(result.projection, target.projection))
    return { outcome: 'no-target', detail: 'projection-changed' };
  const checkpoint = result.checkpoints.find((c) => c.step === position);
  if (!checkpoint) return { outcome: 'no-target', detail: 'target-checkpoint-not-applicable' };
  if (checkpoint.status === 'inconclusive')
    return { outcome: 'incomplete', detail: 'target-checkpoint-inconclusive' };
  if (checkpoint.status === 'match')
    return { outcome: 'no-target', detail: 'target-checkpoint-match' };
  const disk = checkpoint.disk.find((e) => e.path === target.path) ?? null;
  if (!sameEntry(disk, target.disk))
    return { outcome: 'no-target', detail: 'expected-disk-state-changed' };
  const difference = checkpoint.differences.find((d) => d.path === target.path);
  if (!difference) return { outcome: 'no-target', detail: 'different-divergence' };
  if (difference.kind !== target.kind)
    return { outcome: 'no-target', detail: `difference-kind-changed: ${difference.kind}` };
  return { outcome: 'target', detail: 'reproduced' };
}

/** The earliest DIVERGED step checkpoint and its first difference in path order. */
export function selectTarget(result: RunResult): ReductionTarget | undefined {
  if (result.status !== 'diverged' || !result.projection) return undefined;
  const checkpoint = result.checkpoints.find(
    (c) => c.step !== undefined && c.status === 'diverged' && c.differences.length > 0,
  );
  const difference = checkpoint?.differences[0];
  if (!checkpoint || checkpoint.step === undefined || !difference) return undefined;
  return {
    step: checkpoint.step,
    stepName: checkpoint.name,
    path: difference.path,
    kind: difference.kind,
    disk: checkpoint.disk.find((e) => e.path === difference.path) ?? null,
    projection: result.projection,
  };
}

function integer(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  return result;
}

/**
 * Sequential chunk-based delta debugging over whole steps. Operations, content, initial files
 * and step order are never changed; the target step is never removed.
 */
export async function reduceScenario(input: ReduceOptions): Promise<Reduction> {
  const scenario = parseScenario(input.scenario);
  const maxExecutions = integer(input.maxExecutions, 40, 1, 1000, 'Execution budget');
  const deadlineMs = integer(input.deadlineMs, 600000, 100, 3600000, 'Reduction deadline (ms)');
  const execute =
    input.execute ??
    ((candidate: Scenario, signal: AbortSignal) =>
      runScenario({ ...input.run, scenario: candidate, signal }));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const all = scenario.steps.map((_, i) => i);
  const attempts: Attempt[] = [];
  const executions = { baseline: 0, candidate: 0, control: 0 };
  let settings: Pick<ReductionJournal['settings'], 'adapter' | 'observation'> = {
    adapter: null,
    observation: null,
  };
  let target: ReductionTarget | undefined;
  let kept = all;
  let confirmed = false;
  let stop: StopReason | undefined;
  let message = '';
  let control: RunResult | undefined;
  let controlVerdict: Verdict | undefined;
  const interrupted = (): StopReason | undefined =>
    input.signal?.aborted ? 'cancelled' : deadline.signal.aborted ? 'deadline' : undefined;

  /** One real execution in a fresh tree. Returns undefined when it must not start. */
  async function attempt(phase: Attempt['phase'], steps: number[]) {
    stop ??= interrupted();
    if (!stop && phase === 'candidate' && executions.candidate >= maxExecutions) stop = 'budget';
    if (stop) return undefined;
    executions[phase]++;
    const started = performance.now();
    let result: RunResult | undefined;
    let verdict: Verdict;
    try {
      result = await execute({ ...scenario, steps: steps.map((i) => scenario.steps[i]) }, signal);
      if (!settings.adapter) settings = { adapter: result.adapter, observation: result.options };
      verdict = target
        ? classifyRun(result, target, steps.indexOf(target.step))
        : (classifyFailure(result) ?? {
            outcome: result.status === 'diverged' ? 'target' : 'no-target',
            detail: result.status,
          });
    } catch (e) {
      // Rejected before anything ran (for example an out-of-range deadline): a usage error.
      if (attempts.length === 0) throw e;
      verdict = {
        outcome: 'infrastructure-error',
        detail: `runner rejected the execution: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (verdict.outcome === 'cancelled') stop = interrupted() ?? 'cancelled';
    const record: Attempt = {
      seq: attempts.length + 1,
      phase,
      kept: steps,
      outcome: verdict.outcome,
      detail: verdict.detail,
      runStatus: result?.status ?? null,
      ...(result?.failure ? { failure: result.failure } : {}),
      durationMs: Math.round(performance.now() - started),
    };
    attempts.push(record);
    input.onAttempt?.(record);
    return { result, verdict };
  }

  try {
    // Baseline: the first run selects the target, the second must reproduce exactly that target.
    const first = await attempt('baseline', all);
    target = first?.result && selectTarget(first.result);
    if (first && !stop && !target) {
      stop =
        first.verdict.outcome === 'infrastructure-error'
          ? 'infrastructure-error'
          : 'baseline-not-reproducible';
      message = `Baseline produced no divergence to select as target (run status ${first.verdict.detail}).`;
    }
    if (target && !stop) {
      const second = await attempt('baseline', all);
      if (second && !stop) {
        if (second.verdict.outcome === 'target') confirmed = true;
        else {
          stop =
            second.verdict.outcome === 'infrastructure-error'
              ? 'infrastructure-error'
              : 'baseline-not-reproducible';
          message = `The second baseline run did not reproduce the selected target (${second.verdict.outcome}: ${second.verdict.detail}).`;
        }
      }
    }

    if (target && confirmed) {
      const targetStep = target.step;
      const rejected = new Set<string>();
      let infrastructure = 0;
      /** Two reproductions accept a candidate; any other outcome rejects it without a retry. */
      const reproduces = async (candidate: number[]) => {
        const key = candidate.join(',');
        if (rejected.has(key)) return false;
        // A candidate that can no longer be confirmed would only spend the budget.
        if (maxExecutions - executions.candidate < 2) {
          stop ??= interrupted() ?? 'budget';
          return false;
        }
        for (let run = 0; run < 2; run++) {
          const outcome = (await attempt('candidate', candidate))?.verdict.outcome;
          if (stop) return false;
          infrastructure = outcome === 'infrastructure-error' ? infrastructure + 1 : 0;
          if (infrastructure >= INFRASTRUCTURE_LIMIT) {
            stop = 'infrastructure-error';
            message = `${INFRASTRUCTURE_LIMIT} consecutive candidate executions failed with infrastructure errors.`;
            return false;
          }
          if (outcome !== 'target') {
            rejected.add(key);
            return false;
          }
        }
        return true;
      };
      let granularity = 1;
      while (!stop) {
        const removable = kept.filter((i) => i !== targetStep);
        if (!removable.length) break;
        granularity = Math.min(granularity, removable.length);
        const size = Math.ceil(removable.length / granularity);
        let removed = false;
        for (let offset = 0; offset < removable.length && !stop; offset += size) {
          const chunk = new Set(removable.slice(offset, offset + size));
          const candidate = kept.filter((i) => !chunk.has(i));
          if (await reproduces(candidate)) {
            kept = candidate;
            granularity = Math.max(granularity - 1, 2);
            removed = true;
            break;
          }
        }
        if (stop || removed) continue;
        if (granularity >= removable.length) break;
        granularity = Math.min(removable.length, granularity * 2);
      }
      stop ??= 'complete';

      // Independent control replay of the final candidate; not part of the candidate budget.
      if (stop === 'complete' || stop === 'budget') {
        const searchStop = stop;
        stop = undefined;
        const final = await attempt('control', kept);
        // A control stopped by cancellation or the deadline is no control replay at all.
        if (final && final.verdict.outcome !== 'cancelled') {
          control = final.result;
          controlVerdict = final.verdict;
        }
        stop ??= searchStop;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  stop ??= 'infrastructure-error';
  const removedCount = all.length - kept.length;
  let status: ReductionStatus;
  if (stop === 'cancelled') status = 'cancelled';
  else if (stop === 'deadline') status = 'deadline-exceeded';
  else if (stop === 'infrastructure-error') status = 'infrastructure-error';
  else if (stop === 'baseline-not-reproducible') status = 'not-reproducible';
  else if (controlVerdict?.outcome === 'target')
    status = stop === 'budget' ? 'budget-exhausted' : removedCount ? 'reduced' : 'unchanged';
  else if (controlVerdict?.outcome === 'infrastructure-error') status = 'infrastructure-error';
  else status = 'not-reproducible';
  const verification = !confirmed
    ? 'none'
    : controlVerdict?.outcome === 'target'
      ? 'control-reproduced'
      : controlVerdict
        ? 'control-not-reproduced'
        : 'confirmed-without-control';
  const summary = `${all.length} → ${kept.length} steps`;
  const defaults: Record<ReductionStatus, string> = {
    reduced: `Reduced ${summary}; the control replay reproduced the target.`,
    unchanged: 'No step could be removed; the control replay reproduced the target.',
    'budget-exhausted': `Execution budget exhausted at ${summary}; the control replay reproduced the last confirmed candidate.`,
    'deadline-exceeded': `Deadline exceeded at ${summary}; no control replay completed.`,
    cancelled: `Cancelled at ${summary}; no control replay completed.`,
    'not-reproducible': `The control replay did not reproduce the target (${controlVerdict?.outcome}: ${controlVerdict?.detail}) at ${summary}.`,
    'infrastructure-error': `Infrastructure error${controlVerdict ? ` in the control replay (${controlVerdict.detail})` : ''} at ${summary}.`,
  };
  if (!message || controlVerdict) message = defaults[status];
  else if (stop === 'infrastructure-error' && confirmed) message += ` Stopped at ${summary}.`;
  return {
    journal: {
      version: 1,
      status,
      stop,
      message,
      settings: { ...settings, maxExecutions, deadlineMs },
      target: target ?? null,
      steps: {
        original: all.length,
        kept: confirmed ? kept : [],
        names: confirmed ? kept.map((i) => scenario.steps[i].name) : [],
      },
      verification,
      executions,
      files: {
        scenario: confirmed ? 'scenario.json' : null,
        control: control ? 'control.json' : null,
      },
      attempts,
    },
    ...(confirmed ? { scenario: { ...scenario, steps: kept.map((i) => scenario.steps[i]) } } : {}),
    ...(control ? { control } : {}),
  };
}

/** Reject an existing output path before any execution is spent. */
export async function assertNewOutput(out: string): Promise<void> {
  try {
    await lstat(out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!(await lstat(dirname(resolve(out)))).isDirectory())
        throw new Error('Output parent is not a directory');
      return;
    }
    throw e;
  }
  throw new Error(`Output path already exists and is never overwritten: ${out}`);
}

/**
 * Write the artifacts into a staging directory beside `out` and rename it into place, so `out`
 * never holds a partial set. An `out` that appeared in the meantime is left untouched.
 */
export async function writeReduction(out: string, reduction: Reduction): Promise<void> {
  const final = resolve(out);
  await assertNewOutput(final);
  const staging = await mkdtemp(join(dirname(final), `${basename(final)}.partial-`));
  const write = (name: string, value: unknown) =>
    writeFile(join(staging, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  if (reduction.scenario) await write('scenario.json', reduction.scenario);
  if (reduction.control) await write('control.json', reduction.control);
  await write('reduction.json', reduction.journal);
  try {
    await assertNewOutput(final);
    await rename(staging, final);
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}. Complete artifacts were left in ${staging}`,
    );
  }
}
