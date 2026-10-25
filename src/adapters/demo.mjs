// Both examples use real fs.watch. Snapshots serialize the cache and never scan.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
// Windows directory handles can prevent renaming a watched child directory.
// A native recursive subscription keeps only the stable root watched there.
const recursiveRoot = process.platform === 'win32';
let root,
  index = new Map(),
  watches = new Map(),
  revision = 0,
  processing = false,
  scheduled,
  stopping = false;
const send = (message) => process.stdout.write(`${JSON.stringify({ v: 1, ...message })}\n`);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Deliberately independent from the verifier's traversal and hashing module.
function scan(relative = '', output = new Map(), dirs = ['']) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      output.set(path, { path, type: 'directory' });
      dirs.push(path);
      scan(path, output, dirs);
    } else if (stat.isFile())
      output.set(path, { path, type: 'file', hash: hash(join(root, path)) });
  }
  return { output, dirs };
}
function fatal(error) {
  send({ type: 'diagnostic', level: 'error', message: String(error) });
  shutdown();
  process.exitCode = 1;
}
function complete(reason) {
  revision++;
  processing = false;
  send({ type: 'processed', revision, reason });
}
function reconcile() {
  scheduled = undefined;
  try {
    const { output, dirs } = scan();
    // Retain root and existing directories; discard watches for paths invalidated by rename.
    if (!recursiveRoot) {
      for (const [path, watcher] of watches)
        if (!dirs.includes(path)) {
          watcher.close();
          watches.delete(path);
        }
      for (const dir of dirs) if (!watches.has(dir)) attachDirectory(dir);
    }
    index = output;
    complete('directory invalidation reconciliation');
  } catch (e) {
    fatal(e);
  }
}
function attachDirectory(dir) {
  const watcher = watch(join(root, dir), { recursive: recursiveRoot }, (event, filename) => {
    send({
      type: 'event',
      event,
      path: filename == null ? null : `${dir ? `${dir}/` : ''}${filename.toString()}`,
      watched: dir || '.',
    });
    if (!scheduled) {
      processing = true;
      scheduled = setTimeout(reconcile, 15);
    }
  });
  watcher.on('error', fatal);
  watches.set(dir, watcher);
}
function attachFile(path) {
  // BUG: this subscription stays on the original inode. No events are dropped artificially.
  const watcher = watch(join(root, path), (event, filename) => {
    send({ type: 'event', event, path: filename?.toString() ?? null, watched: path });
    processing = true;
    try {
      const stat = lstatSync(join(root, path));
      if (stat.isFile()) index.set(path, { path, type: 'file', hash: hash(join(root, path)) });
      else index.delete(path);
    } catch (e) {
      if (e.code === 'ENOENT') index.delete(path);
      else return fatal(e);
    }
    complete('file callback; subscription unchanged');
  });
  watcher.on('error', fatal);
  watches.set(path, watcher);
}
function shutdown() {
  stopping = true;
  clearTimeout(scheduled);
  for (const watcher of watches.values()) watcher.close();
  watches.clear();
  input.close();
  process.stdin.pause();
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    const m = JSON.parse(line);
    if (m.v !== 1 || typeof m.id !== 'string')
      throw new Error('Expected protocol v1 with request ID');
    if (m.type === 'init' && !root) {
      root = m.root;
      // Establish the root watch before scanning, then child watches before readiness.
      if (mode === 'fixed') attachDirectory('');
      index = scan().output;
      if (mode === 'broken') {
        for (const entry of index.values()) if (entry.type === 'file') attachFile(entry.path);
      } else if (mode === 'fixed' && !recursiveRoot) {
        for (const dir of scan().dirs) if (!watches.has(dir)) attachDirectory(dir);
      } else if (mode !== 'fixed') throw new Error('Expected fixed or broken mode');
      revision++;
      send({
        type: 'ready',
        id: m.id,
        projection: {
          paths: 'relative-posix',
          types: ['file', 'directory'],
          hash: 'sha256',
          excludes: [],
        },
      });
    } else if (m.type === 'snapshot' && root) {
      send({ type: 'snapshot', id: m.id, entries: [...index.values()], revision, processing });
    } else if (m.type === 'stop') {
      send({ type: 'stopped', id: m.id });
      shutdown();
    } else throw new Error('Unexpected request');
  } catch (e) {
    fatal(e);
  }
});
input.on('close', () => {
  if (!stopping) shutdown();
});
process.on('SIGTERM', shutdown);
