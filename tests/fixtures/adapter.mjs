// Protocol fault fixtures only. These are never used as watcher demonstrations.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2],
  input = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify({ v: 1, ...m })}\n`);
let entries = [],
  revision = 100,
  root,
  snapshots = 0;
const interval = setInterval(() => {}, 1000);
function initialEntries(relative = '') {
  return readdirSync(join(root, relative)).flatMap((name) => {
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) return [{ path, type: 'directory' }, ...initialEntries(path)];
    if (!stat.isFile()) return [];
    return [
      {
        path,
        type: 'file',
        hash: createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex'),
      },
    ];
  });
}
input.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'init') {
    root = m.root;
    entries = initialEntries();
    if (mode === 'no-ready') return;
    if (mode === 'exit') process.exit(7);
    if (mode === 'invalid-json') return process.stdout.write('hello logs on stdout\n');
    if (mode === 'oversize') return process.stdout.write('x'.repeat(1024 * 1024 + 1));
    const ready = {
      type: 'ready',
      id: m.id,
      projection: {
        paths: 'relative-posix',
        types: ['file', 'directory'],
        hash: 'sha256',
        excludes: [],
      },
    };
    if (mode === 'bad-version') ready.v = 2;
    if (mode === 'bad-id') ready.id = 'wrong';
    if (mode.startsWith('paths-')) {
      ready.projection.hash = 'none';
      entries = entries.map(({ path, type }) => ({ path, type }));
    }
    if (mode === 'unavailable' || mode === 'unavailable-false')
      ready.snapshotSignals = 'unavailable';
    if (mode === 'missing-projection-hash') delete ready.projection.hash;
    send(ready);
    if (mode === 'duplicate') send(ready);
    if (mode === 'stderr') process.stderr.write('indexer log\n');
  } else if (m.type === 'snapshot') {
    snapshots++;
    if (mode === 'no-snapshot') return;
    if (mode === 'snapshot-exit') process.exit(9);
    if (mode === 'bad-hash') entries[0].hash = 'not-sha256';
    if (mode === 'missing-hash') delete entries[0].hash;
    if (mode === 'paths-error' && snapshots > 1)
      return send({ type: 'diagnostic', level: 'error', message: 'snapshot export failed' });
    if (mode === 'regression') revision--;
    if (mode === 'baseline-mismatch') entries = [];
    const response = {
      type: 'snapshot',
      id: m.id,
      entries,
      revision,
      processing:
        mode === 'processing' ||
        (mode === 'late-processing' && snapshots > 1) ||
        (mode === 'late-idle' && snapshots % 2 === 0),
    };
    if (mode === 'unavailable' || mode === 'undeclared-null') {
      response.revision = null;
      response.processing = null;
    }
    if (mode === 'unavailable-false') response.revision = null;
    if (
      (mode === 'late-response' && snapshots > 1) ||
      (mode === 'late-idle' && snapshots > 1 && snapshots % 2 === 1)
    )
      setTimeout(() => send(response), 200);
    else send(response);
  } else if (m.type === 'stop') {
    if (mode === 'no-stop') return;
    if (mode === 'stop-exit' || mode === 'stop-signal') {
      process.stdout.write(`${JSON.stringify({ v: 1, type: 'stopped', id: m.id })}\n`, () =>
        mode === 'stop-exit' ? process.exit(7) : process.kill(process.pid, 'SIGTERM'),
      );
      return;
    }
    send({ type: 'stopped', id: m.id });
    if (mode === 'stop-hangs') return;
    clearInterval(interval);
    input.close();
    process.stdin.pause();
  }
});
input.on('close', () => {
  if (mode !== 'stop-hangs') clearInterval(interval);
});
