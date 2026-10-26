import type { Difference, Entry, Projection } from './model.ts';

export function validPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\:]/.test(path) &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
export function inScope(path: string, projection: Projection): boolean {
  return !projection.excludes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
export function project(entries: Entry[], projection: Projection): Entry[] {
  return entries
    .filter((e) => projection.types.includes(e.type) && inScope(e.path, projection))
    .map(
      (e): Entry =>
        e.type === 'file' && projection.hash === 'sha256'
          ? { path: e.path, type: e.type, hash: e.hash }
          : { path: e.path, type: e.type },
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** Pure comparison. No watcher observations or filesystem access influence the verdict. */
export function compare(disk: Entry[], index: Entry[]): Difference[] {
  const actual = new Map(disk.map((e) => [e.path, e]));
  const cached = new Map(index.map((e) => [e.path, e]));
  const differences: Difference[] = [];
  for (const path of [...new Set([...actual.keys(), ...cached.keys()])].sort()) {
    const d = actual.get(path),
      i = cached.get(path);
    if (!i) differences.push({ path, kind: 'missing', disk: d });
    else if (!d) differences.push({ path, kind: 'extra', index: i });
    else if (d.type !== i.type)
      differences.push({ path, kind: 'type-mismatch', disk: d, index: i });
    else if (d.type === 'file' && i.type === 'file' && d.hash !== i.hash)
      differences.push({ path, kind: 'content-mismatch', disk: d, index: i });
  }
  return differences;
}
