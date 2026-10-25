export type Entry =
  | { path: string; type: 'file'; hash: string }
  | { path: string; type: 'directory' };
export interface Projection {
  paths: 'relative-posix';
  types: ('file' | 'directory')[];
  hash: 'sha256';
  excludes: string[];
}
export const DEFAULT_PROJECTION: Projection = {
  paths: 'relative-posix',
  types: ['file', 'directory'],
  hash: 'sha256',
  excludes: [],
};
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
  revision: number;
  processing: boolean;
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
  options: { windowMs: number; requestTimeoutMs: number; readyTimeoutMs: number; pollMs: number };
  root?: string;
  cleaned: boolean;
  checkpoints: Checkpoint[];
  observations: Observation[];
}
