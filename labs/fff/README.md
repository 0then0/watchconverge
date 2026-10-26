# FFF paths-only lab

This optional lab runs the real, long-lived FFF native index through WatchConverge's ordinary JSONL client and `runScenario`. Python is a lab dependency only. No application dependency or adapter registry entry is added.

## Recorded environment and install

Tested on macOS 15.7.9 (24G830), Darwin 24.6.0, arm64, Python 3.13.16 and Node 24.22.1. WatchConverge is 0.1.0 at base commit `71a4049ea9c10a47152cc29adf5d7bba867fdd8d` plus this milestone's working-tree changes. No other FFF platform was validated; no FFF integration CI is added.

The dependency is the [official PyPI fff-search 0.11.0 release](https://pypi.org/project/fff-search/0.11.0/), imported as `fff`. The hash-locked `requirements.txt` selects the tested `fff_search-0.11.0-cp310-abi3-macosx_11_0_arm64.whl`:

```text
wheel SHA-256: 4d2296bfe8a60141772fa825003c22856f7b136661f684b8b4d7d9477a4050f5
sdist SHA-256: 569d97283b756054a0843012dad88f27bf89cdee082322a7e264fcd952aae86a
```

API behavior was checked against the wheel's stubs and the published source archive, not inferred from a different SDK version. The corresponding upstream tag `v0.11.0` resolves to commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`.

From the repository root, with Python 3.13 installed:

```sh
python3.13 -m venv /tmp/watchconverge-fff-venv
/tmp/watchconverge-fff-venv/bin/python -m pip install \
  --require-hashes --only-binary=:all: -r labs/fff/requirements.txt
FFF_NATIVE_TESTS=1 /tmp/watchconverge-fff-venv/bin/python -B -m unittest discover -s labs/fff -p 'test_*.py'
node labs/fff/run.ts /tmp/watchconverge-fff-venv/bin/python /tmp/watchconverge-fff-results
```

The recorded environment used `uv venv --python python3.13` and `uv pip install --python ...` with `UV_CACHE_DIR` in an owned temporary directory; the same hash-locked requirement was validated afterwards. No existing project environment was synchronized.

For a single watched run through the CLI (from the repository root):

```sh
node src/cli.ts --scenario directory-rename \
  --adapter-json "[\"/tmp/watchconverge-fff-venv/bin/python\",\"$PWD/labs/fff/adapter.py\"]" \
  --ready-timeout-ms 5000 --request-timeout-ms 1500 --window-ms 1200 --json --export
```

Append `"--no-watch"` to the argv array for the intentional static-index negative control. In the UI select **Custom JSONL adapter…** with the same absolute argv. Each run owns a fresh fixture; no target-directory option is used. Stop/EOF/SIGTERM closes FFF before removing its separate temporary database and log directories. A daemon input reader makes EOF observable during readiness polling; FFF state and cleanup stay on the main thread. There are no descendant processes inside the adapter.

## State, completeness and exclusions

The projection is exactly `{"paths":"relative-posix","types":["file"],"hash":"none","excludes":[]}`. `FileItem` supplies the indexed relative path; its class establishes the file type. Directories, content hashes, timestamps, sizes and other metadata are not compared or reconstructed.

`complete_snapshot` calls **FFF's index query** `finder.glob("**", page_index=0, page_size=10001)`. It does not use a filesystem glob. It checks `len(items) == total_matched == total_files <= 10000`, rejects duplicates and lets WatchConverge validate canonical paths. A failed SDK request is a fatal protocol diagnostic, never an empty tree. Zero files is valid only if all three counts are zero.

A single query holds the native picker read lock through result selection and Python `FileItem` conversion. Asking for one entry beyond the verifier cap obtains all permitted files in one consistent native call; a larger or truncated index is an error, never top-k disguised as completeness. There is no multi-request pagination race. In this version `page_index` is passed as an **offset**, not a page number. The adapter always uses offset zero and does not assume page-number semantics. The optional native test verifies 150 files, beyond the SDK's default page, and confirms snapshots do not repair a static index.

The adapter never calls `scan_files`, `reindex`, grep/content APIs, OS glob/walk, stat or read on the fixture during snapshot. The only initial scan and subsequent watcher-driven changes belong to FFF itself. Content indexing and mmap content caching are disabled. Frecency/history databases and logs live outside the fixture in separate owned temporary directories; no persistent user databases are opened.

There are **no implicit verifier exclusions**. The recorded fixtures are ordinary visible files in non-git trees; they contain no ignore files, hidden paths, symlinks, special files or SDK-reserved dependency/cache directories. FFF has its own ignore policy, including git/ignore rules, hidden-file behavior and built-in non-git exclusions. Its SDK does not expose that policy as a literal-prefix list or provide a switch to disable all ignores. Therefore this lab does not claim general coverage of arbitrary projects or translate ignore globs into verifier prefixes. An ignored file is not silently removed from disk truth: it appears as a missing indexed path (NOT-READY at baseline; with unknown signals later differences remain INCONCLUSIVE). A policy difference is not evidence of a watcher bug. Selected-type/exclude filtering and all resource limits remain enforced by the main runner.

## Readiness and unavailable signals

Readiness polls `scan_progress.is_scanning == false` **and** `is_watcher_ready == true`. `is_scanning` becomes false when the file list is searchable, before watcher installation. Waiting only for `wait_for_scan_blocking()` is insufficient for watched readiness. Elapsed time alone never establishes readiness; the runner bounds the wait. For the explicitly disabled-watch control only initial scan completion is required, and a diagnostic labels that intentional exception.

Public SDK 0.11.0 has no observable native index revision or watcher-queue idle state. Relevant immutable source evidence:

- [Python public API](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/fff-python/src/fff/__init__.pyi): `FileItem`, `ScanProgress`, `FileFinder` methods.
- [Python finder implementation](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-python/src/finder.rs): `glob` holds the picker read guard and converts all returned items inside it; `health_check` only exposes initialization, scan/file count, git and database health. Neither exposes queue state or revision.
- [Core scan](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/scan.rs): file-list commit, `scanning=false`, later watcher installation and `watcher_ready=true` are separate stages.
- [Core watcher](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/watcher/background_watcher.rs): debounce and directory-work queues are private; callbacks are dispatched after applying a batch, not as a global queue-drained barrier. Callback absence/count cannot establish idle/revision.

Watched mode explicitly declares `snapshotSignals: "unavailable"` and sends `revision: null, processing: null`, using the documented additive [protocol extension](../../docs/protocol.md#consumers-without-observable-completion-signals). It cannot yield an idle checkpoint match or PASS, and repeated differences cannot become idle DIVERGED. A matching data baseline permits collecting subsequent samples but remains INCONCLUSIVE. Full strict idle-convergence verification is blocked by the SDK's public observability, not by snapshot completeness. This milestone must not be described as fully completed under the original strict signal requirement.

The `--no-watch` control opens a real FFF index with `watch=False`. After its initial scan there are no path-update producers; the static paths view has adapter generation zero and no pending path work. Only that intentionally static mode reports `revision: 0, processing: false`. These are assertions about the static exported view, not claimed native FFF counters. The index is never restarted or reconstructed after fixture changes.

## Fixed experiment and recorded outcomes

[config.json](config.json) was written before the batch: readiness 5000 ms, snapshot 1500 ms, observation 1200 ms, poll 80 ms; three repetitions each of create, delete, directory-rename and recreate in watched and no-watch modes. Deadlines were not increased. Content-only steps in directory-rename and recreate are explicitly not applicable; atomic-save and burst are entirely not applicable for this projection and are covered by regression tests.

[Portable evidence](../../docs/evidence/fff/) contains:

- `config.json`: environment and exact batch configuration, including the custom create scenario.
- `runs.jsonl`: every full runner result with operations, snapshots, comparison trace, differences, applicability and cleanup. Only host-local argv and fixture paths are replaced by portable placeholders.
- `summary.json`: outcomes per repetition.
- `sandbox/`: all 24 initial restricted-environment outcomes with the same configuration. Each failed opening the database with `Operation not permitted`; none was relabeled as a mismatch or PASS.

With the environment's filesystem restrictions lifted for the same disposable resources: all 12 watched runs reached real watcher readiness and eventually had zero path differences at every applicable checkpoint. All remained **INCONCLUSIVE** because the queue/revision signals are unavailable. All 12 no-watch controls began with a **MATCH** baseline and became **DIVERGED** on stale paths. Recreate's later matching checkpoint did not erase its earlier deletion divergence. Every recorded fixture was cleaned up; there were no request/readiness timeouts in these batches.

The database failure repeated with explicit, separate tree/database/log directories inside the restricted environment. An exploratory no-database run could query the index but never observed watcher readiness within 5 seconds. Outside those restrictions, the same SDK with explicit temporary databases reported scan complete and watcher ready. This isolates the observed failure to an execution-permission-dependent condition; it does not identify the denied syscall or establish a defect in FFF. The adapter keeps the explicit databases and preserves errors instead of silently switching storage modes.

These outcomes establish cached-path sampling and an effective negative control on this host. They do not establish content freshness, idle completion in watched FFF, a FFF defect, continuous agreement, or support on Linux/Windows.

## Repository verification and completion boundary

Final verification on the recorded host:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/watchconverge-playwright npm run validate
FFF_NATIVE_TESTS=1 /tmp/watchconverge-fff-venv/bin/python -B -m unittest discover -s labs/fff -p 'test_*.py'
```

Biome, type checking (including the lab), production build, 61 Node tests and all 6 Chromium tests passed. One Windows-only Node test was explicitly skipped on macOS. All 10 Python tests, including the real 150-file static-index check and subprocess lifecycle checks, passed. The source tree passed `git diff --check`.

Review found that EOF during readiness polling left the adapter alive. The regression test reproduced the failure with the real native index while controlling only the scan/watcher readiness signals; it timed out in both startup phases before the fix. After the fix, EOF before init, during either startup phase and after ready, plus stop and SIGTERM, exit successfully and remove the separate temporary database/log directories. A positive paths-only Node test uses a test-only JSONL proxy over the existing demo consumer's real cached state; create/rename/delete produce PASS while the content-only step remains explicitly not applicable. This is not a watched-FFF PASS claim. A post-fix FFF run through the main runner retained INCONCLUSIVE for watched mode and DIVERGED for the no-watch control, with matching initial data and successful cleanup.

The initial sandbox validation had directory-watch EMFILE failures. A first unrestricted full Node run also observed one directory-rename CLI divergence with the built-in consumer remaining at its initial revision. The unchanged HEAD's CLI tests and the current isolated CLI/integration tests passed; its intermittent cause was not established. The final full run passed without changing the built-in adapter, retries or deadlines. Chromium initially needed its temporary browser location configured; two incorrect locators in the newly added UI test were corrected before final verification. These validation outcomes do not change or discard the fixed FFF batch results.

Criteria 1–3 (explicit projections, legacy SHA-256 compatibility and honest applicability), 5 (effective negative control) and 6 (reproducible evidence) are implemented and checked. Criterion 4 has real FFF cached snapshots and lifecycle integration through the runner, but its original strict processing/revision requirement remains unavailable in public SDK 0.11.0. The explicitly limited evidence mode does not satisfy full idle-convergence verification, so the whole milestone is not declared complete. No FFF bug is claimed.
