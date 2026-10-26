# Validation guide

## Run the complete suite

From a checkout with Node.js 22.18 or later:

```sh
npm ci
npx playwright install chromium
npm run validate
```

On Linux, use `npx playwright install --with-deps chromium` if the browser's system libraries are missing. `validate` runs Biome, TypeScript 7, the production build, Node tests and Chromium tests. It does not launch user-selected adapters or write to a user-supplied fixture directory.

For targeted checks, use the commands in [CONTRIBUTING.md](../CONTRIBUTING.md). Browser tests require a current production build. Servers used by tests bind to loopback; HTTP tests choose an available port, while browser tests use port 4318.

## What the tests establish

- Projection regressions cover explicit mode validation, missing/malformed hashes, paths-only snapshots, content-only inapplicability, stale paths versus stale content, snapshot errors, unavailable signals, and projection/limitation retention in CLI, UI, JSON and HTML. The unreadable-content check requires a non-root POSIX user.
- Comparison tests cover missing and extra paths, content and type mismatches, literal exclusion prefixes, path validation, directories and symlink exclusion.
- Protocol tests cover request IDs, envelope/version validation, cached snapshots, monotonic revisions, readiness and request deadlines, process failure, clean shutdown, nonzero exits after stop, forced termination, cancellation between requests and temporary-tree cleanup.
- Checkpoint tests distinguish an on-time idle match, repeated idle differences, pending processing, late matching responses and insufficient samples. A processing-pending sample cannot count as evidence of repeated idle divergence.
- HTTP tests preserve non-ASCII scenario data across split UTF-8 transport chunks, reject invalid UTF-8 and ensure exports are bound to the requested run UUID.
- CLI tests exercise exports, fresh-tree replay and the documented `npm run --silent cli` command, including JSON-only stdout and the divergence exit code.
- Real-watcher tests run all built-in scenarios against the directory-invalidation consumer. A test-only JSONL proxy also projects that existing cache to paths/types, verifying PASS after create/rename/delete with content-only assertions explicitly omitted. The file-watch example demonstrates stale inode subscriptions on Linux/macOS; Windows reports that example as unsupported.
- Chromium tests exercise run/stop/error states, light/dark/system themes, malformed imports, stale-tab exports, notifications, disk/index differences and report downloads. The HTML report is opened through a local file URL without HTTP requests.

A passing test suite validates these cases. It does not prove continuous index agreement, exhaustive watcher correctness or accessibility conformance.

## Operating systems and CI

The [CI workflow](../.github/workflows/ci.yml) runs on Linux, macOS and Windows with Node 22 and 24. Each job installs locked dependencies, checks formatting and types, builds the UI, runs Node tests and runs Chromium tests. Failed browser checks retain traces as workflow artifacts. An unsupported test includes a skip reason; a skip is not a passing experiment.

For published run outcomes, use the repository's [Actions page](https://github.com/0then0/watchconverge/actions/workflows/ci.yml). The Bun case study has separate [recorded runtime evidence](bun-36328.md), including its tested architecture and limitations.

## Run Node tests in isolated Linux

The Node suite can run from a read-only source mount. This example uses the recorded Linux arm64 Node 24.22.1 image; an x86 host needs arm64 container support or a separately selected native image.

```sh
docker run --rm --platform linux/arm64 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 512m --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env npm_config_cache=/tmp/npm-cache \
  --mount "type=bind,source=$PWD,target=/work,readonly" -w /work \
  node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 \
  npm test
```

The runtime creates fixture/export directories in the container's `/tmp`; the source mount is read-only. These native Node tests do not need the host's `node_modules`. Build and browser checks remain separate and need their installed dependencies. Docker may download the image before starting the network-disabled container.

## Troubleshooting

### A watcher fails with EMFILE, ENOSPC or a permission error

Check process file-descriptor limits, OS watcher limits and whether the execution environment permits native filesystem watchers. Some restricted environments reject directory watches even when file-descriptor limits are ample. Run the same test in a local environment that permits watchers. Keep the result as an infrastructure error; do not relabel it as lost events, a platform skip or PASS.

### Browser tests cannot start

Install Chromium and its platform prerequisites using Playwright. Build the UI before running `npm run test:ui`, and ensure port 4318 is free. Test failures write traces to `test-results/`; inspect them with `npx playwright show-trace path/to/trace.zip`.

### JSON output contains npm log lines

Use `npm run --silent cli -- --json`, or invoke `node src/cli.ts --json` directly. npm's own script banners are not part of the result format.

### An export returns HTTP 409

Another run has replaced the result referenced by the link, or that result is no longer available. Refresh the UI and export the current completed run, or replay the original scenario. The server intentionally refuses to substitute another run's evidence.

### A result reports incomplete cleanup

Read the error and retained root path in the result. Close any processes retaining files in that tree before removing it manually. Adapters must stop their own descendants; the runner terminates its direct child. Abrupt process or host termination can prevent cleanup even when normal error paths are covered.

## Optional FFF lab

The [FFF lab](../labs/fff/README.md) is isolated from npm runtime and CI. Its checked-in configuration fixes deadlines before three repetitions per scenario and mode. `runs.jsonl` keeps complete results, observations and differences, including failed readiness/infrastructure outcomes. Native SDK tests also verify a complete 150-file export, a static index that stays stale after disk changes, EOF before/during/after readiness, stop and SIGTERM, and removal of temporary databases/logs. Only the recorded macOS arm64 environment was exercised; do not infer other-platform support from the application's CI matrix.
