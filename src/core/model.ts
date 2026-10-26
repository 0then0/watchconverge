export type Entry =
  | { path: string; type: 'file'; hash?: string }
  | { path: string; type: 'directory' };
export interface Projection {
  paths: 'relative-posix';
  types: ('file' | 'directory')[];
  hash: 'sha256' | 'none';
  excludes: string[];
}
export const DEFAULT_PROJECTION: Projection = {
  paths: 'relative-posix',
  types: ['file', 'directory'],
  hash: 'sha256',
  excludes: [],
};
export function describeProjection(p: Projection): string {
  return `${p.types.join(' + ')} · relative POSIX paths · ${p.hash === 'sha256' ? 'SHA-256 content' : 'paths and types only; file content is not checked'}. Excluded prefixes: ${p.excludes.join(', ') || 'none'}.`;
}
export type SnapshotSignals = 'reported' | 'unavailable';
export type Difference = {
  path: string;
  kind: 'missing' | 'extra' | 'content-mismatch' | 'type-mismatch';
  disk?: Entry;
  index?: Entry;
};
export type Operation =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'atomic'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; path: string; to: string };
export interface Scenario {
  version: 1;
  id: string;
  name: string;
  description: string;
  initial: { path: string; content: string }[];
  steps: { name: string; operations: Operation[] }[];
}
export type RunStatus =
  | 'running'
  | 'pass'
  | 'diverged'
  | 'not-ready'
  | 'inconclusive'
  | 'error'
  | 'stopped'
  | 'unsupported';
export interface Observation {
  seq: number;
  ms: number;
  kind:
    | 'lifecycle'
    | 'operation'
    | 'event'
    | 'processed'
    | 'snapshot'
    | 'comparison'
    | 'diagnostic';
  message: string;
  data?: unknown;
}
export interface Checkpoint {
  id: string;
  name: string;
  status: 'match' | 'diverged' | 'inconclusive';
  observedMs: number;
  samples: number;
  revision: number | null;
  processing: boolean | null;
  disk: Entry[];
  index: Entry[];
  differences: Difference[];
  skipped: string[];
}
export interface RunResult {
  version: 1;
  id: string;
  scenario: Scenario;
  adapter: string[];
  platform: string;
  node: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  message: string;
  projection?: Projection;
  snapshotSignals?: SnapshotSignals;
  limitations: string[];
  assertions: { step: string; checked: boolean; reason: string }[];
  options: { windowMs: number; requestTimeoutMs: number; readyTimeoutMs: number; pollMs: number };
  root?: string;
  cleaned: boolean;
  checkpoints: Checkpoint[];
  observations: Observation[];
}
