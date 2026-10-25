# Contributing to WatchConverge

## Set up the project

Use Node.js 22.18 or later and the committed npm lockfile:

```sh
npm ci
npx playwright install chromium
npm run dev
```

The development UI runs at [http://127.0.0.1:4317](http://127.0.0.1:4317). `npm run build` creates the production UI in `dist`; `npm start` serves that build. The CLI runs directly from TypeScript source through Node's native type stripping. Type checking uses TypeScript 7; Node type declarations are development dependencies; CI checks the supported Node 22 and 24 runtimes.

## Run checks

```sh
npm run check       # Biome formatting, import organization and recommended lint rules
npm run typecheck   # TypeScript without emitting files
npm run build       # Type check and production UI build
npm test           # Node unit, HTTP, CLI and real-watcher integration tests
npm run test:ui    # Chromium tests against the production build
npm run validate   # All checks, in the order required by CI
```

Run `npm run build` before browser tests. On Linux, `npx playwright install --with-deps chromium` also installs the browser's system prerequisites. These commands use disposable local resources; none needs a production service or user-supplied target tree.

`npm run check:fix` applies safe Biome fixes; `npm run format` formats supported source and configuration files. Git checks out text files with LF endings on every platform, matching Biome's configuration. The lockfile, generated output and captured regression evidence are excluded from formatting. Keep functional changes focused and add tests for observable behavior rather than duplicating the implementation. Use Conventional Commits in English.

## Source layout

- `src/core/runner.ts` owns temporary trees, scenario operations, checkpoints, cancellation and cleanup. CLI and UI share this runner.
- `src/core/disk.ts` independently reads ground truth; `compare.ts` applies the projection and compares snapshots without consulting notifications.
- `src/core/protocol.ts` validates JSONL and manages adapter requests, deadlines and process shutdown.
- `src/adapters/demo.mjs` contains the intentionally broken file-watch consumer and the directory-invalidation example. Snapshot handlers must continue to read the cache without rescanning.
- `src/core/report.ts` produces escaped, script-free HTML for both CLI and UI exports.
- `src/server.ts`, `src/ui/` and `src/cli.ts` provide the local HTTP interface, React UI and CLI.
- `tests/` contains comparison, protocol, HTTP, CLI, real-watcher and browser tests. Protocol fault fixtures are not watcher demonstrations.
- `scripts/bun-36328.mjs` is a standalone external regression probe; its source hash and raw results are documented in the [case study](docs/bun-36328.md).

## Preserve the experiment

WatchConverge tests the consumer's cached state, not a required event sequence. Treat repeated, coalesced and filename-free notifications as observations. Keep ground-truth traversal independent of adapter reconciliation. Do not turn a timeout, unsupported platform or failed infrastructure check into PASS.

All scenario writes must stay in tool-owned temporary trees. Symlinks must not be traversed. User adapters are trusted processes, not sandboxes. Protocol changes should preserve version and request-ID validation; changes to the scenario or result format need corresponding documentation and regression tests.

## Report a bug

Open an [issue](https://github.com/0then0/watchconverge/issues) with the operating system, Node version, scenario, adapter command and observed result. Attach an exported scenario/result or HTML report when possible. Redact command arguments and logs containing secrets or personal paths. Distinguish cached-state divergence from notification evidence, and include any readiness, process or cleanup error.

For a runtime-specific watcher regression, provide the actual runtime version/revision and a minimal script using real watcher APIs. Record unsupported environments explicitly rather than substituting synthetic event loss.

## Community and security

Follow the [code of conduct](CODE_OF_CONDUCT.md) in project spaces. Report vulnerabilities through the private channel described in [SECURITY.md](SECURITY.md), not a public issue. Use the issue and pull request templates to include reproducible evidence.

## Release process

The maintainer releases from a clean main branch after the six-platform/runtime CI matrix passes. Update the package version and lockfile together, add user-facing changes to [CHANGELOG.md](CHANGELOG.md), and verify `npm run validate`. Create a GitHub release with a matching `vX.Y.Z` tag at the validated commit using `gh release create`; do not publish the private npm package. GitHub provides source archives. Installation from a release still requires Node, `npm ci` and `npm run build`.
