import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { describeProjection } from './core/model.ts';
import { assertNewOutput, reduceScenario, writeReduction } from './core/reduce.ts';
import { renderReport } from './core/report.ts';
import { runScenario } from './core/runner.ts';
import { parseScenario, scenarios } from './core/scenarios.ts';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scenario: { type: 'string', default: 'atomic-save' },
      adapter: { type: 'string', default: 'fixed' },
      'adapter-json': { type: 'string' },
      'scenario-file': { type: 'string' },
      'window-ms': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'ready-timeout-ms': { type: 'string' },
      out: { type: 'string' },
      'max-executions': { type: 'string' },
      'deadline-ms': { type: 'string' },
      export: { type: 'boolean' },
      json: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const reduce = positionals.length === 1 && positionals[0] === 'reduce';
  if (positionals.length && !reduce) throw new Error('Unknown command; the only command is reduce');
  if (
    !reduce &&
    (values.out !== undefined ||
      values['max-executions'] !== undefined ||
      values['deadline-ms'] !== undefined)
  )
    throw new Error('--out, --max-executions and --deadline-ms apply to the reduce command only');
  if (reduce && values.export)
    throw new Error('reduce writes its artifacts to --out; omit --export');
  const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  if (values.help)
    console.log(
      `WatchConverge v0.2 (Node >=22.18)\n\nnpm run --silent cli -- [--scenario atomic-save] [--adapter fixed|broken]\n  --list                         List scenarios\n  --scenario-file FILE           Replay an exported scenario (read only)\n  --adapter-json '["exe","arg"]'  Explicitly run trusted adapter code; no shell\n  --window-ms 1200               Observation window per checkpoint (100..10000)\n  --request-timeout-ms 1500      Bound each snapshot request (50..10000)\n  --ready-timeout-ms 5000        Bound explicit readiness (50..15000)\n  --export                       Export into a new owned OS temporary directory\n  --json                         Write result JSON to stdout, logs to stderr\n\nUse npm's --silent option with --json to keep npm banners out of stdout.\nExit: 0 checkpoint matches; 1 divergence; 2 error/not-ready/inconclusive; 3 stopped; 4 unsupported.\n\nnpm run --silent cli -- reduce --scenario-file FILE --adapter broken --out NEW-DIR\n  Remove whole steps while one selected divergence still reproduces. Accepts the adapter and\n  deadline options above; --json writes the reduction journal to stdout.\n  --out NEW-DIR                  Required; must not exist. Receives scenario.json, control.json, reduction.json\n  --max-executions 40            Candidate execution budget (1..1000); baseline and control are separate\n  --deadline-ms 600000           Overall reduction deadline (100..3600000)\nExit: 0 reduced or unchanged with a reproducing control replay; 2 not reproducible or infrastructure error;\n  3 cancelled; 5 budget or deadline stop.\n\nNo option accepts a target tree. Every run creates and removes its own temporary tree.`,
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
    const settings = {
      adapter: values.adapter,
      command,
      windowMs: number(values['window-ms']),
      requestTimeoutMs: number(values['request-timeout-ms']),
      readyTimeoutMs: number(values['ready-timeout-ms']),
    };
    if (reduce) {
      if (!values.out) throw new Error('reduce requires --out with a new directory path');
      await assertNewOutput(values.out);
      const reduction = await reduceScenario({
        scenario,
        run: settings,
        maxExecutions: number(values['max-executions']),
        deadlineMs: number(values['deadline-ms']),
        signal: controller.signal,
        onAttempt: (a) =>
          console.error(
            `#${String(a.seq).padStart(2)} ${a.phase.padEnd(9)} steps [${a.kept.join(',')}] · ${a.outcome} (${a.detail}) · ${a.durationMs} ms`,
          ),
      });
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await writeReduction(values.out, reduction);
      const journal = reduction.journal;
      if (values.json) console.log(JSON.stringify(journal, null, 2));
      else {
        if (journal.target)
          console.log(
            `Target: step index ${journal.target.step} (${journal.target.stepName}) · ${journal.target.kind} · ${journal.target.path}`,
          );
        if (reduction.scenario)
          console.log(
            `Steps: ${journal.steps.original} → ${journal.steps.kept.length}; kept original indexes ${journal.steps.kept.join(', ')} (${journal.verification})`,
          );
        console.log(
          `Executions: baseline ${journal.executions.baseline} · candidate ${journal.executions.candidate}/${journal.settings.maxExecutions} · control ${journal.executions.control}`,
        );
        console.log(`${journal.status.toUpperCase()}: ${journal.message}`);
      }
      console.error(`Reduction output: ${values.out}`);
      process.exitCode =
        journal.status === 'reduced' || journal.status === 'unchanged'
          ? 0
          : journal.status === 'cancelled'
            ? 3
            : journal.status === 'budget-exhausted' || journal.status === 'deadline-exceeded'
              ? 5
              : 2;
    } else {
      const result = await runScenario({
        scenario,
        ...settings,
        signal: controller.signal,
        onObservation: values.json
          ? undefined
          : (o) =>
              console.error(`+${String(o.ms).padStart(5)}ms ${o.kind.padEnd(11)} ${o.message}`),
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
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
