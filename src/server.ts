import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, RunResult } from './core/model.ts';
import { renderReport } from './core/report.ts';
import { adapters, runScenario } from './core/runner.ts';
import { parseScenario, scenarios } from './core/scenarios.ts';

const dev = process.argv.includes('--dev');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let current:
  | { id: number; phase: string; observations: Observation[]; result?: RunResult }
  | undefined;
let controller: AbortController | undefined,
  active: Promise<void> | undefined,
  counter = 0;
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    !req.headers['content-type']?.startsWith('application/json') ||
    req.headers['x-watchconverge'] !== '1'
  )
    throw new Error('JSON and X-WatchConverge: 1 are required');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
const server = createServer((req, res) => {
  void handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
    else res.end();
  });
});
const vite = dev
  ? await (await import('vite')).createServer({
      root: projectRoot,
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    })
  : undefined;
async function handle(req: IncomingMessage, res: ServerResponse) {
  const address = server.address();
  const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 4317}`;
  if (
    req.headers.host !== host ||
    (req.headers.origin && req.headers.origin !== `http://${host}`)
  ) {
    json(res, { error: 'Only the local same-origin UI may access this server' }, 403);
    return;
  }
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (url.pathname === '/api/catalog' && req.method === 'GET') {
    json(res, { scenarios, adapters, platform: process.platform });
    return;
  }
  if (url.pathname === '/api/run' && req.method === 'GET') {
    json(res, current ?? null);
    return;
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    const data = await body(req);
    if (controller) {
      json(res, { error: 'A run is already active' }, 409);
      return;
    }
    const scenario =
      typeof data.scenario === 'string'
        ? scenarios.find((s) => s.id === data.scenario)
        : parseScenario(data.scenario);
    if (!scenario) throw new Error('Unknown scenario');
    const adapter = data.adapter === undefined ? 'fixed' : data.adapter;
    if (adapter !== 'fixed' && adapter !== 'broken' && adapter !== 'custom')
      throw new Error('Unknown adapter');
    let command: string[] | undefined;
    if (adapter === 'custom') {
      if (
        !Array.isArray(data.command) ||
        !data.command.length ||
        !data.command.every((c) => typeof c === 'string' && c.length > 0)
      )
        throw new Error('Custom adapter requires a JSON argv array');
      command = data.command;
    }
    if (
      data.windowMs !== undefined &&
      (typeof data.windowMs !== 'number' ||
        !Number.isInteger(data.windowMs) ||
        data.windowMs < 100 ||
        data.windowMs > 10000)
    )
      throw new Error('Observation window must be 100..10000 ms');
    controller = new AbortController();
    const state = {
      id: ++counter,
      phase: 'running',
      observations: [] as Observation[],
      result: undefined as RunResult | undefined,
    };
    current = state;
    active = runScenario({
      scenario,
      adapter,
      command,
      windowMs: data.windowMs as number | undefined,
      signal: controller.signal,
      onObservation: (o) => state.observations.push(o),
    })
      .then((result) => {
        state.result = result;
        state.phase = result.status;
      })
      .catch((e) => {
        state.phase = 'error';
        state.observations.push({
          seq: state.observations.length + 1,
          ms: 0,
          kind: 'diagnostic',
          message: String(e),
        });
      })
      .finally(() => {
        controller = undefined;
      });
    json(res, { id: state.id }, 202);
    return;
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    await body(req);
    controller?.abort();
    json(res, { stopping: Boolean(controller) });
    return;
  }
  if (url.pathname.startsWith('/api/export/') && req.method === 'GET') {
    const runId = url.searchParams.get('runId');
    if (!runId) {
      json(res, { error: 'Export requires a runId' }, 400);
      return;
    }
    const result = current?.result;
    if (!result || result.id !== runId) {
      json(
        res,
        {
          error:
            'This run is no longer available. Export the current completed run or run the scenario again.',
        },
        409,
      );
      return;
    }
    const kind = url.pathname.slice('/api/export/'.length);
    if (!['scenario.json', 'result.json', 'report.html'].includes(kind)) {
      json(res, { error: 'Unknown export' }, 404);
      return;
    }
    res.writeHead(200, {
      'Content-Type': kind.endsWith('html') ? 'text/html; charset=utf-8' : 'application/json',
      'Content-Disposition': `attachment; filename="watchconverge-${kind}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(
      kind === 'report.html'
        ? renderReport(result)
        : JSON.stringify(kind === 'scenario.json' ? result.scenario : result, null, 2),
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, { error: 'Not found' }, 404);
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (vite) {
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end();
    });
    return;
  }
  const directory = resolve(projectRoot, 'dist');
  const path = resolve(
    directory,
    `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
  );
  if (!path.startsWith(directory + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const content = await readFile(path);
    res.writeHead(200, {
      'Content-Type':
        (
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
          } as Record<string, string>
        )[extname(path)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found. Run npm run build before npm start.');
  }
}
const port = Number(process.env.PORT ?? 4317);
server.listen(port, '127.0.0.1', () => {
  const a = server.address();
  console.log(`WatchConverge: http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}`);
});
async function shutdown() {
  controller?.abort();
  await active;
  await vite?.close();
  server.closeAllConnections();
  server.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
