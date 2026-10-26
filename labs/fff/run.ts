import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../../src/core/model.ts';
import { runScenario } from '../../src/core/runner.ts';
import { parseScenario, scenarios } from '../../src/core/scenarios.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const python = resolve(process.argv[2] ?? '/tmp/watchconverge-fff-venv/bin/python');
const output = process.argv[3]
  ? resolve(process.argv[3])
  : await mkdtemp(join(tmpdir(), 'watchconverge-fff-lab-'));
const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
if (process.argv[3]) await mkdir(output); // Refuse to overwrite any prior batch.
console.log(`Evidence: ${output}`);
const rows: { mode: string; scenario: string; repetition: number; result: RunResult }[] = [];
const environment = {
  watchconverge: JSON.parse(await readFile(join(directory, '../../package.json'), 'utf8')).version,
  baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: 'milestone changes; see source in checkout',
  node: process.version,
  python: execFileSync(python, ['--version'], { encoding: 'utf8' }).trim(),
  fff: execFileSync(python, ['-c', 'import fff; print(fff.__version__)'], {
    encoding: 'utf8',
  }).trim(),
  platform: `${process.platform}/${process.arch}`,
  osRelease: release(),
};
await writeFile(join(output, 'config.json'), JSON.stringify({ environment, config }, null, 2));
for (const mode of config.modes) {
  for (const id of config.scenarios) {
    const scenario = parseScenario(
      id === 'create' ? config.create : scenarios.find((s) => s.id === id),
    );
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const result = await runScenario({
        scenario,
        command: [
          python,
          join(directory, 'adapter.py'),
          ...(mode === 'no-watch' ? ['--no-watch'] : []),
        ],
        ...config.deadlines,
      });
      // Keep full outcomes, differences and trace, replacing only host-local paths.
      const portable = JSON.parse(
        JSON.stringify(result)
          .replaceAll(result.root ?? '\0', '<owned-fixture>')
          .replaceAll(python, '$PYTHON')
          .replaceAll(join(directory, 'adapter.py'), 'labs/fff/adapter.py'),
      ) as RunResult;
      rows.push({ mode, scenario: id, repetition, result: portable });
      await writeFile(
        join(output, 'runs.jsonl'),
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
      console.log(
        `${mode} ${id} ${repetition}/${config.repetitions}: ${result.status} (${result.checkpoints.map((c) => `${c.name}: ${c.status}, ${c.differences.length} differences`).join('; ')})`,
      );
    }
  }
}
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify(
    rows.map(({ mode, scenario, repetition, result }) => ({
      mode,
      scenario,
      repetition,
      status: result.status,
      message: result.message,
      baseline: result.checkpoints[0]?.status,
      cleaned: result.cleaned,
    })),
    null,
    2,
  ),
);
