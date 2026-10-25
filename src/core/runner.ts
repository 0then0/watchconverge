import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { compare, project } from './compare.ts';
import { readDisk } from './disk.ts';
import type { Checkpoint, Observation, Operation, RunResult, Scenario } from './model.ts';
import { AdapterClient, AdapterError } from './protocol.ts';
import { parseScenario } from './scenarios.ts';

export const adapters = [
  {
    id: 'fixed',
    name: 'Directory invalidation',
    description: 'Reconciles its cache on real directory notifications.',
  },
  {
    id: 'broken',
    name: 'Stale file subscription',
    description:
      'Keeps the original file watch after atomic replacement. Inode demonstration on Linux/macOS.',
  },
] as const;
export function builtinCommand(id: string): string[] {
  if (id !== 'fixed' && id !== 'broken') throw new Error('Unknown built-in adapter');
  return [process.execPath, fileURLToPath(new URL('../adapters/demo.mjs', import.meta.url)), id];
}
export interface RunOptions {
  scenario: Scenario;
  adapter?: string;
  command?: string[];
  windowMs?: number;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onObservation?: (observation: Observation) => void;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`Deadline must be an integer in ${min}..${max} ms`);
  return result;
}

export async function runScenario(input: RunOptions): Promise<RunResult> {
  const scenario = parseScenario(input.scenario);
  const options = {
    windowMs: bounded(input.windowMs, 1200, 100, 10000),
    requestTimeoutMs: bounded(input.requestTimeoutMs, 1500, 50, 10000),
    readyTimeoutMs: bounded(input.readyTimeoutMs, 5000, 50, 15000),
    pollMs: bounded(input.pollMs, 80, 10, 1000),
  };
  const command = input.command ?? builtinCommand(input.adapter ?? 'fixed');
  const start = performance.now();
  const result: RunResult = {
    version: 1,
    id: randomUUID(),
    scenario,
    adapter: command,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    startedAt: new Date().toISOString(),
    status: 'running',
    message: 'Creating an owned temporary tree',
    options,
    cleaned: false,
    checkpoints: [],
    observations: [],
  };
  function observe(kind: Observation['kind'], message: string, data?: unknown) {
    // Retain a bounded timeline; a flooding adapter is an infrastructure failure, never a pass.
    if (result.observations.length >= 15000)
      throw new AdapterError('limit', 'Observation limit exceeded');
    const observation: Observation = {
      seq: result.observations.length + 1,
      ms: Math.round(performance.now() - start),
      kind,
      message,
      data,
    };
    result.observations.push(observation);
    input.onObservation?.(observation);
  }
  let client: AdapterClient | undefined, root: string | undefined;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error('Overall run deadline exceeded (120 s)')),
    120000,
  );
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    if (
      !input.command &&
      input.adapter === 'broken' &&
      process.platform !== 'linux' &&
      process.platform !== 'darwin'
    ) {
      result.status = 'unsupported';
      result.message =
        'The broken inode demonstration is supported on Linux and macOS only; this is not PASS.';
      return result;
    }
    root = await mkdtemp(join(tmpdir(), 'watchconverge-run-'));
    result.root = root;
    observe('lifecycle', 'Created a fresh temporary tree', { root });
    for (const file of scenario.initial) {
      await mkdir(dirname(join(root, file.path)), { recursive: true });
      await writeFile(join(root, file.path), file.content);
    }
    client = new AdapterClient(
      command,
      root,
      (kind, message, data) => {
        try {
          observe(kind, message, data);
        } catch {
          deadline.abort(new Error('Observation limit exceeded'));
        }
      },
      signal,
    );
    observe('lifecycle', 'Waiting for explicit adapter readiness');
    const adapterClient = client;
    const tree = root;
    const projection = await adapterClient.ready(tree, options.readyTimeoutMs);
    result.projection = projection;
    observe(
      'lifecycle',
      'Adapter ready; subscriptions and initial index established',
      result.projection,
    );
    let previousRevision = -1;
    const checkpoint = async (name: string): Promise<Checkpoint> => {
      const id = randomUUID();
      signal.throwIfAborted();
      adapterClient.assertHealthy();
      const truth = await readDisk(tree, projection);
      const started = performance.now();
      const until = started + options.windowMs;
      let samples = 0;
      let idleMismatches = 0;
      let last: Checkpoint;
      do {
        signal.throwIfAborted();
        const snapshot = await adapterClient.snapshot(options.requestTimeoutMs);
        if (snapshot.revision < previousRevision)
          throw new AdapterError('protocol', 'Snapshot revision moved backwards');
        previousRevision = snapshot.revision;
        const index = project(snapshot.entries, projection);
        const differences = compare(truth.entries, index);
        samples++;
        if (!snapshot.processing && differences.length > 0) idleMismatches++;
        const elapsed = performance.now() - started;
        const late = elapsed > options.windowMs;
        const match = differences.length === 0 && !snapshot.processing && !late;
        last = {
          id,
          name,
          status: match
            ? 'match'
            : snapshot.processing || (late && differences.length === 0)
              ? 'inconclusive'
              : 'diverged',
          observedMs: Math.round(elapsed),
          samples,
          revision: snapshot.revision,
          processing: snapshot.processing,
          disk: truth.entries,
          index,
          differences,
          skipped: truth.skipped,
        };
        observe(
          'snapshot',
          `${name} · revision ${snapshot.revision} · ${snapshot.processing ? 'processing' : 'idle'}`,
          { entries: index, revision: snapshot.revision, processing: snapshot.processing },
        );
        observe(
          'comparison',
          `${name} · ${match ? 'checkpoint match' : `${differences.length} differences${snapshot.processing ? ' (processing pending)' : ''}${late ? ' (response after observation deadline)' : ''}`}`,
          { differences, checkpoint: name },
        );
        if (match) return last;
        const remaining = until - performance.now();
        if (remaining <= 0) break;
        await delay(Math.min(options.pollMs, remaining), undefined, { signal });
      } while (performance.now() < until);
      last.observedMs = Math.round(performance.now() - started);
      if (last.status === 'diverged' && idleMismatches < 2) last.status = 'inconclusive';
      return last;
    };
    const baseline = await checkpoint('Initial index');
    result.checkpoints.push(baseline);
    if (baseline.status !== 'match') {
      result.status = 'not-ready';
      result.message =
        'Ready was received, but the initial index did not establish a matching baseline. Scenario operations were not started.';
      return result;
    }
    for (const step of scenario.steps) {
      for (const operation of step.operations) {
        signal.throwIfAborted();
        client.assertHealthy();
        await perform(root, operation);
        observe('operation', describeOperation(operation), operation);
      }
      observe('lifecycle', `Writes stopped · observing ${step.name}`);
      result.checkpoints.push(await checkpoint(step.name));
    }
    client.assertHealthy();
    if (result.checkpoints.some((c) => c.status === 'diverged')) {
      result.status = 'diverged';
      result.message =
        'Index differs from disk in samples across the observation window. This does not identify a lost notification.';
    } else if (result.checkpoints.some((c) => c.status === 'inconclusive')) {
      result.status = 'inconclusive';
      result.message =
        'The observation window could not establish convergence or repeated idle mismatches: processing was pending, a matching response was late, or too few samples arrived.';
    } else {
      result.status = 'pass';
      result.message =
        'Selected projection matched at every checked checkpoint. This does not prove correctness between checkpoints or for other scenarios.';
    }
  } catch (e) {
    if (input.signal?.aborted) {
      result.status = 'stopped';
      result.message = 'Stopped by user; incomplete checkpoints are not PASS.';
    } else {
      result.status =
        e instanceof AdapterError && e.code === 'ready-timeout' ? 'not-ready' : 'error';
      result.message = e instanceof Error ? e.message : String(e);
    }
  } finally {
    clearTimeout(timer);
    try {
      await client?.close();
    } catch (e) {
      result.status = 'error';
      result.message = `Adapter cleanup failed: ${String(e)}`;
    }
    try {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.cleaned = true;
    } catch (e) {
      result.status = 'error';
      result.message = `Temporary tree cleanup failed: ${String(e)}`;
    }
    result.finishedAt = new Date().toISOString();
    if (result.observations.length < 15000)
      observe(
        'lifecycle',
        `${result.status.toUpperCase()} · ${result.cleaned ? 'temporary tree removed' : 'cleanup failed'}`,
      );
  }
  return result;
}

async function safeParents(root: string, relative: string) {
  let current = root;
  // Do not traverse symlinks even when a trusted adapter has created one.
  for (const part of relative.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory())
        throw new Error('Operation parent is not a regular directory');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') await mkdir(current);
      else throw e;
    }
  }
  try {
    if ((await lstat(join(root, relative))).isSymbolicLink())
      throw new Error('Scenario operations do not follow symlinks');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
async function perform(root: string, op: Operation) {
  await safeParents(root, op.path);
  const path = join(root, op.path);
  if (op.kind === 'write') await writeFile(path, op.content);
  else if (op.kind === 'delete') await rm(path, { recursive: true });
  else if (op.kind === 'rename') {
    await safeParents(root, op.to);
    await rename(path, join(root, op.to));
  } else {
    const temporary = join(dirname(path), `.watchconverge-${randomUUID()}.tmp`);
    await writeFile(temporary, op.content, { flag: 'wx' });
    await rename(temporary, path);
  }
}
export function describeOperation(op: Operation): string {
  if (op.kind === 'rename') return `rename ${op.path} → ${op.to}`;
  if (op.kind === 'write' || op.kind === 'atomic')
    return `${op.kind === 'atomic' ? 'atomic replace' : 'write'} ${op.path} · ${Buffer.byteLength(op.content)} bytes`;
  return `delete ${op.path}`;
}
