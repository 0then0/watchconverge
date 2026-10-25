// External acceptance probe. Run the SAME source with real Bun versions on Linux.
// No injected/dropped events. The consumer updates only the named path, like a
// small incremental indexer. Event traces are evidence, not the verdict.

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = {
  case: 'oven-sh/bun#36328',
  startedAt: new Date().toISOString(),
  runtime: process.versions.bun,
  revision: globalThis.Bun?.revision ?? null,
  platform: `${process.platform}/${process.arch}`,
  kernel: release(),
  observationWindowMs: 700,
  status: 'unsupported',
  trials: [],
  cleaned: false,
};
if (process.platform !== 'linux' || !process.versions.bun) {
  console.log(JSON.stringify(result));
  process.exitCode = 4;
} else {
  result.status = 'pass';
  for (let trial = 0; trial < 10; trial++) {
    const root = mkdtempSync(join(tmpdir(), 'watchconverge-bun-'));
    const events = [],
      cache = new Map();
    let watcher;
    try {
      const path = join(root, 'app.tsx');
      writeFileSync(path, 'v0');
      cache.set('app.tsx', sha(path));
      watcher = watch(root, (event, filename) => {
        events.push({ event, path: filename?.toString() ?? null });
        if (filename == null) return; // Filename-directed consumer; null cannot refresh an individual path.
        const name = filename.toString();
        try {
          if (lstatSync(join(root, name)).isFile()) cache.set(name, sha(join(root, name)));
        } catch (e) {
          if (e.code === 'ENOENT') cache.delete(name);
          else throw e;
        }
      });
      let watchError;
      watcher.on('error', (e) => {
        watchError = String(e);
      });
      await sleep(300);
      if (watchError) throw new Error(watchError);
      const tmp = join(root, 'app.tsx.tmp');
      writeFileSync(tmp, 'v1');
      renameSync(tmp, path);
      // Observe the existing cache over a bounded window after writes stop.
      const disk = readdirSync(root)
        .filter((n) => lstatSync(join(root, n)).isFile())
        .map((path) => ({ path, type: 'file', hash: sha(join(root, path)) }));
      let differences,
        index,
        samples = 0;
      const until = performance.now() + 700;
      do {
        await sleep(50);
        samples++;
        if (watchError) throw new Error(watchError);
        index = [...cache].map(([path, hash]) => ({ path, type: 'file', hash }));
        differences = disk.flatMap((d) => {
          const i = index.find((i) => i.path === d.path);
          return !i
            ? [{ kind: 'missing', path: d.path }]
            : i.hash !== d.hash
              ? [{ kind: 'content-mismatch', path: d.path }]
              : [];
        });
        differences.push(
          ...index
            .filter((i) => !disk.some((d) => d.path === i.path))
            .map((i) => ({ kind: 'extra', path: i.path })),
        );
        if (!differences.length) break;
      } while (performance.now() < until);
      result.trials.push({
        trial: trial + 1,
        status: differences.length ? 'diverged' : 'pass',
        disk,
        index,
        differences,
        samples,
        events,
        destinationNamed: events.some((e) => e.path === 'app.tsx'),
      });
      if (differences.length) result.status = 'diverged';
    } catch (e) {
      result.status = 'error';
      result.trials.push({ trial: trial + 1, status: 'error', message: String(e), events });
    } finally {
      watcher?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  result.cleaned = true;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'diverged' ? 1 : 2;
}
