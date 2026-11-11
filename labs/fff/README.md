# FFF paths-only lab

This optional lab connects [FFF](https://github.com/dmtrKovalenko/fff), a file finder with a long-lived native index and its own file watcher, to WatchConverge. It serves as a worked example of an adapter for a third-party indexer and as a record of one experiment with its limits.

The lab contains:

- `adapter.py`: a WatchConverge adapter that exports FFF's in-memory file list over the [JSONL protocol](../../docs/protocol.md).
- `run.ts`: runs the fixed batch from `config.json` through the ordinary runner and writes the results.
- `test_adapter.py`, `test_lifecycle.py`: Python tests for snapshot completeness and process lifecycle.
- `requirements.txt`: the hash-locked FFF Python SDK.

In short: FFF's index is compared by paths only, because the SDK exposes no content hashes. In watched mode the paths matched at every applicable checkpoint, but every run is INCONCLUSIVE, because the SDK does not expose whether watcher work is still pending. A control with the watcher disabled diverges as expected. No FFF defect is claimed.

Python is needed only for this lab. The application, its tests and CI do not depend on it, and the lab is not run in CI.

## Recorded environment and install

Tested on macOS 15.7.9 (24G830), Darwin 24.6.0, arm64, Python 3.13.16 and Node 24.22.1. No other platform was validated. The recorded batch ran on WatchConverge 0.1.0 at commit `71a4049ea9c10a47152cc29adf5d7bba867fdd8d` with uncommitted working-tree changes from the development of 0.2.0; that exact tree was not recorded as a commit.

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

The recorded environment was created with `uv venv --python python3.13` and `uv pip install` instead of `venv` and `pip`, from the same hash-locked requirements.

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

Watched mode explicitly declares `snapshotSignals: "unavailable"` and sends `revision: null, processing: null`, using the [protocol's unavailable-signals mode](../../docs/protocol.md#consumers-without-observable-completion-signals). It cannot yield an idle checkpoint match or PASS, and repeated differences cannot become idle DIVERGED. A matching data baseline permits collecting subsequent samples but remains INCONCLUSIVE. Idle-convergence verification is blocked by what the SDK exposes publicly, not by snapshot completeness.

The `--no-watch` control opens a real FFF index with `watch=False`. After its initial scan there are no path-update producers; the static paths view has adapter generation zero and no pending path work. Only that intentionally static mode reports `revision: 0, processing: false`. These are assertions about the static exported view, not claimed native FFF counters. The index is never restarted or reconstructed after fixture changes.

## Fixed experiment and recorded outcomes

[config.json](config.json) was fixed before the batch ran: readiness 5000 ms, snapshot 1500 ms, observation 1200 ms, poll 80 ms; three repetitions each of create, delete, directory-rename and recreate in watched and no-watch modes. Deadlines were not increased. Content-only steps in directory-rename and recreate are explicitly not applicable; atomic-save and burst are entirely not applicable for this projection and are covered by regression tests.

[Portable evidence](../../docs/evidence/fff/) contains:

- `config.json`: environment and exact batch configuration, including the custom create scenario.
- `runs.jsonl`: every full runner result with operations, snapshots, comparison trace, differences, applicability and cleanup. Only host-local argv and fixture paths are replaced by portable placeholders.
- `summary.json`: outcomes per repetition.
- `sandbox/`: all 24 outcomes of the same configuration in a restricted execution environment. Each failed opening the database with `Operation not permitted`; none was relabeled as a mismatch or PASS.

Outside that restricted environment, with the same disposable resources: all 12 watched runs reached real watcher readiness and eventually had zero path differences at every applicable checkpoint. All remained **INCONCLUSIVE** because the queue/revision signals are unavailable. All 12 no-watch controls began with a **MATCH** baseline and became **DIVERGED** on stale paths. Recreate's later matching checkpoint did not erase its earlier deletion divergence. Every recorded fixture was cleaned up; there were no request/readiness timeouts in these batches.

The database failure repeated with explicit, separate tree/database/log directories inside the restricted environment. An exploratory no-database run could query the index but never observed watcher readiness within 5 seconds. Outside those restrictions, the same SDK with explicit temporary databases reported scan complete and watcher ready. This isolates the observed failure to an execution-permission-dependent condition; it does not identify the denied syscall or establish a defect in FFF. The adapter keeps the explicit databases and preserves errors instead of silently switching storage modes.

These outcomes establish cached-path sampling and an effective negative control on this host. They do not establish content freshness, idle completion in watched FFF, a FFF defect, continuous agreement, or support on Linux/Windows.

## Verify the lab

```sh
FFF_NATIVE_TESTS=1 /tmp/watchconverge-fff-venv/bin/python -B -m unittest discover -s labs/fff -p 'test_*.py'
```

The 12 Python tests use the real native index. They cover:

- A complete export of 150 files, beyond the SDK's default page size.
- A static index that stays stale after disk changes, confirming that snapshots do not repair it.
- Stdin EOF before `init`, during the scan and watcher-startup phases and after `ready`, plus `stop` and SIGTERM. Each ends with a successful exit and removal of the temporary database and log directories.
- Input stream failures, including decoding errors, and SDK snapshot failures. Each is reported as a fatal diagnostic with a nonzero exit and resource cleanup.

`npm run typecheck` includes `run.ts`. The application's own test suite does not run this lab; its paths-only behavior is covered separately by a test-only JSONL proxy over the built-in consumer.

## Limitations

- Watched FFF runs cannot produce PASS or DIVERGED, because public SDK 0.11.0 exposes neither an index revision nor watcher-queue state.
- Only paths of regular files are compared. Content freshness, directories and metadata are outside the projection.
- The recorded fixtures are ordinary visible files in non-git trees. FFF's ignore rules are not translated into verifier exclusions, so the lab does not cover arbitrary projects.
- Only macOS arm64 was exercised. The restricted-environment database failure was not traced to a specific denied operation.
