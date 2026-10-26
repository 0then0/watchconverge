import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inScope, project } from './compare.ts';
import type { Entry, Projection } from './model.ts';

/** Ground truth: independent traversal, only after the runner has stopped writes. */
export async function readDisk(root: string, projection: Projection) {
  const entries: Entry[] = [],
    skipped: string[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      if (!inScope(path, projection)) continue;
      const absolute = join(root, path),
        stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        skipped.push(path);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path, type: 'directory' });
        await visit(path);
      } else if (stat.isFile())
        entries.push({
          path,
          type: 'file',
          ...(projection.hash === 'sha256'
            ? {
                hash: createHash('sha256')
                  .update(await readFile(absolute))
                  .digest('hex'),
              }
            : {}),
        });
      else skipped.push(path);
    }
  }
  await visit('');
  return { entries: project(entries, projection), skipped };
}
