import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { validPath } from './compare.ts';
import type { Entry, Projection } from './model.ts';

export class AdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
type Message = Record<string, unknown>;
export function parseProjection(value: unknown): Projection {
  const p = value as Projection | undefined;
  if (
    p?.paths !== 'relative-posix' ||
    p.hash !== 'sha256' ||
    !Array.isArray(p.types) ||
    !p.types.length ||
    p.types.some((t) => t !== 'file' && t !== 'directory') ||
    new Set(p.types).size !== p.types.length ||
    !Array.isArray(p.excludes) ||
    p.excludes.length > 100 ||
    !p.excludes.every(validPath)
  )
    throw new AdapterError(
      'protocol',
      'Unsupported projection; expected relative-posix, file/directory, sha256 and literal exclude prefixes',
    );
  return p;
}
export function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new AdapterError('protocol', 'Invalid or oversized snapshot');
  const seen = new Set<string>();
  for (const e of value) {
    if (
      !e ||
      !validPath(e.path) ||
      seen.has(e.path) ||
      (e.type !== 'file' && e.type !== 'directory') ||
      (e.type === 'file' && (typeof e.hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.hash)))
    )
      throw new AdapterError('protocol', 'Invalid snapshot entry, hash or duplicate path');
    seen.add(e.path);
  }
  return value.map((e) =>
    e.type === 'file'
      ? { path: e.path, type: 'file', hash: e.hash }
      : { path: e.path, type: 'directory' },
  );
}

export class AdapterClient {
  child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      type: string;
      resolve: (m: Message) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cancel: () => void;
    }
  >();
  private counter = 0;
  private failure?: Error;
  private buffer = '';
  private closing = false;
  private exited = false;
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  private exitPromise: Promise<void>;
  private decoder = new StringDecoder('utf8');
  private signal?: AbortSignal;
  constructor(
    command: string[],
    root: string,
    observe: (kind: 'event' | 'processed' | 'diagnostic', message: string, data?: unknown) => void,
    signal?: AbortSignal,
  ) {
    if (!command.length || command.some((c) => typeof c !== 'string' || !c || c.includes('\0')))
      throw new AdapterError('spawn', 'Adapter command must be a non-empty argv array');
    this.signal = signal;
    this.child = spawn(command[0], command.slice(1), {
      cwd: root,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('close', (code, sig) => {
        this.exited = true;
        this.exitInfo = { code, signal: sig };
        if (!this.closing) this.fail(new AdapterError('exit', `Adapter exited (${code ?? sig})`));
        resolve();
      });
    });
    this.child.on('error', (e) => this.fail(new AdapterError('spawn', e.message)));
    this.child.stdin.on('error', (e) => {
      if (!this.closing) this.fail(new AdapterError('stdin', e.message));
    });
    this.child.stderr.on('data', (data: Buffer) =>
      observe('diagnostic', data.toString('utf8').slice(0, 4000), { source: 'stderr' }),
    );
    this.child.stdout.on('data', (data: Buffer) => {
      if (this.failure || (this.closing && this.exited)) return;
      this.buffer += this.decoder.write(data);
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.fail(new AdapterError('protocol', 'JSONL buffer exceeds 1 MiB'));
        return;
      }
      while (this.buffer.includes('\n')) {
        const newline = this.buffer.indexOf('\n');
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const m = JSON.parse(line) as Message;
          if (!m || typeof m !== 'object' || m.v !== 1 || typeof m.type !== 'string')
            throw new Error('Invalid envelope or protocol version');
          if (m.type === 'event' || m.type === 'processed' || m.type === 'diagnostic') {
            if (
              m.type === 'event' &&
              (typeof m.event !== 'string' || (m.path !== null && typeof m.path !== 'string'))
            )
              throw new Error('Invalid event');
            if (
              m.type === 'processed' &&
              (!Number.isSafeInteger(m.revision) || Number(m.revision) < 0)
            )
              throw new Error('Invalid processed revision');
            if (
              m.type === 'diagnostic' &&
              (typeof m.message !== 'string' ||
                !['info', 'warn', 'error'].includes(String(m.level)))
            )
              throw new Error('Invalid diagnostic');
            observe(
              m.type,
              String(
                m.message ??
                  (m.type === 'event'
                    ? `${m.event}: ${m.path ?? '(directory invalidated)'}`
                    : `Consumer processing complete · revision ${m.revision}`),
              ),
              m,
            );
            if (m.type === 'diagnostic' && m.level === 'error') throw new Error(String(m.message));
          } else {
            const pending = typeof m.id === 'string' ? this.pending.get(m.id) : undefined;
            if (!pending || pending.type !== m.type)
              throw new Error('Unknown/duplicate request ID or unexpected response type');
            clearTimeout(pending.timer);
            pending.cancel();
            this.pending.delete(String(m.id));
            pending.resolve(m);
          }
        } catch (e) {
          this.fail(new AdapterError('protocol', e instanceof Error ? e.message : String(e)));
          return;
        }
      }
    });
    this.child.stdout.on('end', () => {
      this.buffer += this.decoder.end();
      if (this.buffer.trim())
        this.fail(
          new AdapterError('protocol', 'Adapter stdout ended with an incomplete JSONL line'),
        );
    });
    this.child.stdout.on('error', (e) => this.fail(new AdapterError('stdout', e.message)));
    this.child.stderr.on('error', (e) => this.fail(new AdapterError('stderr', e.message)));
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.cancel();
      p.reject(this.failure);
    }
    this.pending.clear();
  }
  assertHealthy() {
    if (this.failure) throw this.failure;
  }
  request(type: string, response: string, fields: Message, timeoutMs: number): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited) return Promise.reject(new AdapterError('exit', 'Adapter already exited'));
    if (this.signal?.aborted && type !== 'stop') return Promise.reject(this.signal.reason);
    const id = `r${++this.counter}`;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(new AdapterError('aborted', 'Run stopped'));
      const signal = type === 'stop' ? undefined : this.signal;
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          this.fail(
            new AdapterError(
              type === 'init' ? 'ready-timeout' : 'request-timeout',
              `${response} timed out after ${timeoutMs} ms; this does not prove a lost event`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, {
        type: response,
        resolve,
        reject,
        timer,
        cancel: () => signal?.removeEventListener('abort', abort),
      });
      this.child.stdin.write(`${JSON.stringify({ v: 1, type, id, ...fields })}\n`);
    });
  }
  async ready(root: string, timeoutMs: number): Promise<Projection> {
    const message = await this.request('init', 'ready', { root }, timeoutMs);
    return parseProjection(message.projection);
  }
  async snapshot(timeoutMs: number) {
    const m = await this.request('snapshot', 'snapshot', {}, timeoutMs);
    if (
      !Number.isSafeInteger(m.revision) ||
      Number(m.revision) < 0 ||
      typeof m.processing !== 'boolean'
    )
      throw new AdapterError('protocol', 'Snapshot requires revision and processing');
    return {
      entries: parseEntries(m.entries),
      revision: Number(m.revision),
      processing: m.processing,
    };
  }
  async close(): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    const healthyOnEntry = !this.failure && !this.signal?.aborted;
    let shutdownError: unknown;
    if (healthyOnEntry) {
      try {
        await this.request('stop', 'stopped', {}, 400);
      } catch (e) {
        shutdownError = e;
      }
    }
    this.child.stdin.end();
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exitPromise,
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
      clearTimeout(timer);
    };
    await wait(200);
    let forced = false;
    if (!this.exited) {
      forced = true;
      this.child.kill('SIGTERM');
      await wait(300);
    }
    if (!this.exited) {
      this.child.kill('SIGKILL');
      await wait(500);
    }
    const observedFailure = this.failure;
    this.fail(new AdapterError('closed', 'Adapter closed'));
    if (!this.exited)
      throw new AdapterError('cleanup', 'Adapter did not exit after forced termination');
    if (shutdownError) throw shutdownError;
    if (healthyOnEntry && observedFailure) throw observedFailure;
    if (healthyOnEntry && forced)
      throw new AdapterError(
        'cleanup',
        'Adapter required forced termination after stop acknowledgment',
      );
    if (healthyOnEntry && (this.exitInfo?.code !== 0 || this.exitInfo.signal !== null))
      throw new AdapterError(
        'exit',
        `Adapter exited (${this.exitInfo?.code ?? this.exitInfo?.signal ?? 'unknown'}) after stop acknowledgment`,
      );
  }
}
