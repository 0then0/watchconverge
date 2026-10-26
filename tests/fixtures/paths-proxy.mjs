// Test-only projection of the existing real demo consumer's cache. No new watcher or scan.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../../src/adapters/demo.mjs', import.meta.url)), 'fixed'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {}); // Child failure is reported by the exit code.
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'ready') message.projection.hash = 'none';
  if (message.type === 'snapshot')
    message.entries = message.entries.map(({ path, type }) => ({ path, type }));
  process.stdout.write(`${JSON.stringify(message)}\n`);
});
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  process.stdin.pause();
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
