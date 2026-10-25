import { validPath } from './compare.ts';
import type { Scenario } from './model.ts';

export const scenarios: Scenario[] = [
  {
    version: 1,
    id: 'atomic-save',
    name: 'Atomic save, then write',
    description:
      'Replace app.txt with a new file object, then write v2 at the same path. Exposes a watch attached to the old inode.',
    initial: [{ path: 'app.txt', content: 'v0\n' }],
    steps: [
      {
        name: 'Atomic replacement · v1',
        operations: [{ kind: 'atomic', path: 'app.txt', content: 'v1\n' }],
      },
      {
        name: 'Write to replacement · v2',
        operations: [{ kind: 'write', path: 'app.txt', content: 'v2\n' }],
      },
    ],
  },
  {
    version: 1,
    id: 'recreate',
    name: 'Delete & recreate',
    description: 'Remove a file, verify absence, recreate it, then write another version.',
    initial: [{ path: 'app.txt', content: 'original\n' }],
    steps: [
      { name: 'Delete file', operations: [{ kind: 'delete', path: 'app.txt' }] },
      {
        name: 'Recreate at same path',
        operations: [{ kind: 'write', path: 'app.txt', content: 'recreated\n' }],
      },
      {
        name: 'Write new version',
        operations: [{ kind: 'write', path: 'app.txt', content: 'latest\n' }],
      },
    ],
  },
  {
    version: 1,
    id: 'directory-rename',
    name: 'Rename directory',
    description:
      'Rename src to lib and change its nested file. Directory notifications may invalidate a whole subtree.',
    initial: [{ path: 'src/nested/app.txt', content: 'before\n' }],
    steps: [
      { name: 'Rename src → lib', operations: [{ kind: 'rename', path: 'src', to: 'lib' }] },
      {
        name: 'Edit nested file',
        operations: [{ kind: 'write', path: 'lib/nested/app.txt', content: 'after\n' }],
      },
    ],
  },
  {
    version: 1,
    id: 'burst',
    name: 'Overwrite burst',
    description:
      'Twenty consecutive writes. Only the final version is compared; no event count is required.',
    initial: [{ path: 'app.txt', content: 'v0\n' }],
    steps: [
      {
        name: '20 overwrites · verify v20',
        operations: Array.from({ length: 20 }, (_, i) => ({
          kind: 'write' as const,
          path: 'app.txt',
          content: `v${i + 1}\n`,
        })),
      },
    ],
  },
  {
    version: 1,
    id: 'delete',
    name: 'Delete from index',
    description: 'A deleted file must disappear from the consumer index.',
    initial: [
      { path: 'app.txt', content: 'remove me\n' },
      { path: 'keep.txt', content: 'keep me\n' },
    ],
    steps: [{ name: 'Delete app.txt', operations: [{ kind: 'delete', path: 'app.txt' }] }],
  },
];

export function parseScenario(value: unknown): Scenario {
  if (!value || typeof value !== 'object') throw new Error('Scenario must be an object');
  const s = value as Scenario;
  if (
    s.version !== 1 ||
    typeof s.id !== 'string' ||
    typeof s.name !== 'string' ||
    typeof s.description !== 'string' ||
    !Array.isArray(s.initial) ||
    !Array.isArray(s.steps) ||
    !s.steps.length ||
    s.steps.length > 50 ||
    s.initial.length > 100
  )
    throw new Error('Invalid scenario v1');
  const content = (v: unknown) => typeof v === 'string' && v.length <= 65536;
  if (s.initial.some((f) => !f || !validPath(f.path) || !content(f.content)))
    throw new Error('Invalid initial files');
  for (const step of s.steps) {
    if (
      !step ||
      typeof step.name !== 'string' ||
      !Array.isArray(step.operations) ||
      step.operations.length > 100
    )
      throw new Error('Invalid scenario step');
    for (const op of step.operations) {
      if (
        !op ||
        !validPath(op.path) ||
        !['write', 'atomic', 'delete', 'rename'].includes(op.kind) ||
        ((op.kind === 'write' || op.kind === 'atomic') && !content(op.content)) ||
        (op.kind === 'rename' && !validPath(op.to))
      )
        throw new Error('Invalid operation or unsafe relative path');
    }
  }
  return s;
}
