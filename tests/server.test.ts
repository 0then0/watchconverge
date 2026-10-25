import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RunResult, Scenario } from '../src/core/model.ts';

let server: ChildProcessWithoutNullStreams;
let origin: string;
before(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    let output = '';
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.stdout.on('data', (chunk) => {
      output += String(chunk);
      const url = output.match(/WatchConverge: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
});
after(async () => {
  if (!server?.pid || server.exitCode !== null) return;
  const closed = once(server, 'close');
  const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
  server.kill('SIGTERM');
  try {
    await closed;
  } finally {
    clearTimeout(timeout);
  }
});

const scenario: Scenario = {
  version: 1,
  id: 'utf8',
  name: 'UTF-8 content',
  description: 'Preserve scenario bytes through HTTP',
  initial: [{ path: 'каталог/файл.txt', content: 'Я' }],
  steps: [{ name: 'Existing state', operations: [] }],
};
async function completed(): Promise<RunResult> {
  const until = performance.now() + 10000;
  while (performance.now() < until) {
    const state = (await (await fetch(`${origin}/api/run`)).json()) as { result?: RunResult };
    if (state.result) return state.result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Run did not complete');
}
async function submit(value: unknown) {
  return fetch(`${origin}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WatchConverge': '1' },
    body: JSON.stringify(value),
  });
}
function sendBytes(
  payload: Buffer,
  splitAt?: number,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}/api/run`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'X-WatchConverge': '1',
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    if (splitAt === undefined) req.end(payload);
    else {
      req.write(payload.subarray(0, splitAt));
      // Separate network writes to exercise a multibyte character split between chunks.
      setTimeout(() => req.end(payload.subarray(splitAt)), 50);
    }
  });
}
test('HTTP preserves UTF-8 paths and content split between transport chunks', async () => {
  const payload = Buffer.from(JSON.stringify({ scenario, adapter: 'fixed' }));
  const response = await sendBytes(payload, payload.indexOf(Buffer.from('Я')) + 1);
  assert.equal(response.status, 202, response.body);
  const result = await completed();
  assert.equal(result.status, 'pass', result.message);
  assert.deepEqual(result.scenario, scenario);
  assert.ok(
    result.checkpoints[0].disk.some(
      (entry) => entry.path === 'каталог/файл.txt' && entry.type === 'file',
    ),
  );
  assert.equal(result.cleaned, true);
});
test('invalid UTF-8 is rejected before a run starts', async () => {
  const response = await sendBytes(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  assert.equal(response.status, 400, response.body);
  assert.ok(JSON.parse(response.body).error);
});
test('exports require the displayed run UUID and never substitute a newer result', async () => {
  assert.equal((await submit({ scenario, adapter: 'fixed' })).status, 202);
  const first = await completed();
  for (const name of ['scenario.json', 'result.json', 'report.html']) {
    const response = await fetch(`${origin}/api/export/${name}?runId=${first.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (name === 'result.json') assert.equal(((await response.json()) as RunResult).id, first.id);
    else if (name === 'scenario.json') assert.deepEqual(await response.json(), scenario);
    else assert.ok((await response.text()).includes(first.id));
  }
  assert.equal((await fetch(`${origin}/api/export/result.json`)).status, 400);
  assert.equal(
    (
      await submit({
        scenario: { ...scenario, id: 'second', name: 'Second run' },
        adapter: 'fixed',
      })
    ).status,
    202,
  );
  assert.equal((await fetch(`${origin}/api/export/result.json?runId=${first.id}`)).status, 409);
  const second = await completed();
  assert.notEqual(second.id, first.id);
  for (const name of ['scenario.json', 'result.json', 'report.html'])
    assert.equal((await fetch(`${origin}/api/export/${name}?runId=${first.id}`)).status, 409);
  const current = await fetch(`${origin}/api/export/result.json?runId=${second.id}`);
  assert.equal(current.status, 200);
  assert.equal(((await current.json()) as RunResult).id, second.id);
});
