import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { describeProjection } from './core/model.ts';
import { renderReport } from './core/report.ts';
import { runScenario } from './core/runner.ts';
import { parseScenario, scenarios } from './core/scenarios.ts';

try {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'atomic-save' },
      adapter: { type: 'string', default: 'fixed' },
      'adapter-json': { type: 'string' },
      'scenario-file': { type: 'string' },
      'window-ms': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'ready-timeout-ms': { type: 'string' },
      export: { type: 'boolean' },
      json: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `WatchConverge v0.2 (Node >=22.18)\n\nnpm run --silent cli -- [--scenario atomic-save] [--adapter fixed|broken]\n  --list                         List scenarios\n  --scenario-file FILE           Replay an exported scenario (read only)\n  --adapter-json '["exe","arg"]'  Explicitly run trusted adapter code; no shell\n  --window-ms 1200               Observation window per checkpoint (100..10000)\n  --request-timeout-ms 1500      Bound each snapshot request (50..10000)\n  --ready-timeout-ms 5000        Bound explicit readiness (50..15000)\n  --export                       Export into a new owned OS temporary directory\n  --json                         Write result JSON to stdout, logs to stderr\n\nUse npm's --silent option with --json to keep npm banners out of stdout.\nExit: 0 checkpoint matches; 1 divergence; 2 error/not-ready/inconclusive; 3 stopped; 4 unsupported.\nNo option accepts a target tree. Every run creates and removes its own temporary tree.`,
    );
  else if (values.list)
    console.log(scenarios.map((s) => `${s.id.padEnd(20)} ${s.name}`).join('\n'));
  else {
    const scenario = values['scenario-file']
      ? parseScenario(JSON.parse(await readFile(values['scenario-file'], 'utf8')))
      : scenarios.find((s) => s.id === values.scenario);
    if (!scenario) throw new Error('Unknown scenario; use --list');
    let command: string[] | undefined;
    if (values['adapter-json']) {
      const argv: unknown = JSON.parse(values['adapter-json']);
      if (
        !Array.isArray(argv) ||
        !argv.length ||
        !argv.every((a) => typeof a === 'string' && a.length > 0)
      )
        throw new Error('--adapter-json must be a non-empty JSON argv array');
      command = argv;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const result = await runScenario({
      scenario,
      adapter: values.adapter,
      command,
      signal: controller.signal,
      windowMs: values['window-ms'] === undefined ? undefined : Number(values['window-ms']),
      requestTimeoutMs:
        values['request-timeout-ms'] === undefined
          ? undefined
          : Number(values['request-timeout-ms']),
      readyTimeoutMs:
        values['ready-timeout-ms'] === undefined ? undefined : Number(values['ready-timeout-ms']),
      onObservation: values.json
        ? undefined
        : (o) => console.error(`+${String(o.ms).padStart(5)}ms ${o.kind.padEnd(11)} ${o.message}`),
    });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (values.export) {
      const directory = await mkdtemp(join(tmpdir(), 'watchconverge-export-'));
      await writeFile(join(directory, 'scenario.json'), JSON.stringify(result.scenario, null, 2));
      await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
      await writeFile(join(directory, 'report.html'), renderReport(result));
      console.error(`Exports: ${directory}`);
    }
    if (!values.json) {
      if (result.projection) console.log(`Projection: ${describeProjection(result.projection)}`);
      for (const limitation of result.limitations) console.log(`Not verified: ${limitation}`);
      for (const assertion of result.assertions.filter((a) => !a.checked))
        console.log(`NOT APPLICABLE: ${assertion.step}: ${assertion.reason}`);
    }
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : `${result.status.toUpperCase()}: ${result.message}`,
    );
    process.exitCode =
      result.status === 'pass'
        ? 0
        : result.status === 'diverged'
          ? 1
          : result.status === 'stopped'
            ? 3
            : result.status === 'unsupported'
              ? 4
              : 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
