# Scenario format

A scenario describes initial UTF-8 files and a sequence of operation groups. WatchConverge creates a new temporary tree for each execution, writes the initial files, starts the consumer and checks its initial index before running any operations. A checkpoint follows every group; operations within a group run sequentially without intermediate checkpoints.

Use the UI's **Import scenario** control or the CLI's `--scenario-file` option. Exported `scenario.json` files use the same format.

## Example

```json
{
  "version": 1,
  "id": "atomic-save",
  "name": "Atomic save, then write",
  "description": "Replace a file and verify a subsequent write at the same path.",
  "initial": [{ "path": "app.txt", "content": "v0\n" }],
  "steps": [
    {
      "name": "Replace with v1",
      "operations": [{ "kind": "atomic", "path": "app.txt", "content": "v1\n" }]
    },
    {
      "name": "Write v2",
      "operations": [{ "kind": "write", "path": "app.txt", "content": "v2\n" }]
    }
  ]
}
```

`version` must be `1`. `id`, `name` and `description` are strings. `initial` is an array of `{path, content}` objects; `steps` is a non-empty array of `{name, operations}` objects. An empty operations array is allowed when a checkpoint without additional writes is useful. Import validation completes before the scenario replaces the selected UI value or starts a run.

## Operations

- `write`: `{ "kind": "write", "path": "app.txt", "content": "next\n" }` creates or truncates a file and writes UTF-8 content. Missing parent directories are created.
- `atomic`: `{ "kind": "atomic", "path": "app.txt", "content": "next\n" }` writes a new temporary file beside the target and renames it over the target. The built-in scenario starts with an existing target. The checkpoint follows the rename, after the temporary path has disappeared.
- `delete`: `{ "kind": "delete", "path": "app.txt" }` removes an existing file or directory tree. A nonexistent target is an error.
- `rename`: `{ "kind": "rename", "path": "src", "to": "lib" }` renames a file or directory using the host filesystem. Missing destination parents are created; overwrite and failure behavior follows the operating system.

There is no operation for an arbitrary delay, symlink, shell command or external directory. Use checkpoints and the observation window to establish the states to inspect. Checkpoints sample agreement; they do not prescribe an event count or guarantee that every intermediate overwrite was indexed.

## Paths and limits

Paths are relative to the owned temporary tree, use `/` separators on every OS and are limited to 1,024 characters. Absolute paths, drive prefixes, backslashes, control characters, empty components, `.` and `..` are rejected. Operations reject symlink targets and symlink parents. Initial files and operations must form a valid sequence for the host filesystem; incompatible files/directories or renames fail as infrastructure errors.

The parser accepts at most 100 initial files, 50 steps and 100 operations per step. Each content field is limited to 65,536 UTF-16 code units, the unit used by JavaScript string length. HTTP requests and UI-imported files are additionally limited to 1 MiB. File hashes cover the actual bytes written, not JavaScript character counts. Valid UTF-8 is preserved across HTTP transport chunks; malformed UTF-8 is rejected.

## Replay and export

```sh
npm run --silent cli -- --scenario-file /absolute/path/to/scenario.json --adapter fixed --json
```

Choose the adapter and deadline settings again when replaying. The scenario file contains operations and content; adapter arguments, runtime details and the observation settings belong to `result.json`. A replay creates a fresh tree and does not attempt to reproduce exact event timings.

The server retains only the latest result. UI export links include the displayed result's UUID. A missing UUID is rejected with HTTP 400, and an expired or mismatched UUID with HTTP 409; the server never substitutes another run's evidence.

## Reducing a diverging scenario

```sh
npm run --silent cli -- reduce --scenario-file /absolute/path/to/scenario.json --adapter broken --out /absolute/path/to/new-directory
```

`reduce` removes whole `steps` entries from a scenario that diverges and keeps a smaller scenario that still shows the same divergence. It never edits operations, content, initial files or step order, and it never writes to the input file. `--adapter`, `--adapter-json`, `--window-ms`, `--request-timeout-ms` and `--ready-timeout-ms` work as in a normal run and apply unchanged to every execution. Each execution is an ordinary run: a fresh temporary tree and a new adapter process, one at a time.

### Target

The first baseline run selects the target: the earliest step checkpoint with status DIVERGED and, at that checkpoint, the first difference in path order. A second baseline run must reproduce it; otherwise the reduction ends as `not-reproducible`. The target identity is exactly:

- `step`: the zero-based position of the step in the input `steps` array. Step names are labels and may repeat.
- `path`: the relative path of the difference.
- `kind`: `missing`, `extra`, `content-mismatch` or `type-mismatch`.
- `disk`: the expected disk entry for that path at the checkpoint (type and, with SHA-256, hash), or `null` when the path is absent on disk.
- `projection`: the projection declared by the adapter.

Run UUIDs, timestamps, sample counts and the stale value held by the index are not part of the identity.

The target step is never removed. A candidate reproduces the target only when its run is DIVERGED, the checkpoint of the target step is itself DIVERGED, the disk entry for the path equals the baseline's, and the same difference kind is reported for that path there. A divergence on another path, at another checkpoint, of another kind, or against different disk content does not count. As in any run, DIVERGED means repeated idle mismatches inside the observation window; it does not identify a lost notification or any other internal cause.

### Search and budgets

The search is sequential chunk-based delta debugging: it first tries to remove all steps except the target, then halves, then smaller groups down to single steps. A candidate is accepted after two reproductions. Any other first or second outcome rejects it without a retry, and a rejected set of steps is not executed again.

- `--max-executions` (default 40, 1..1000) bounds candidate executions, confirmations included. A candidate is not started when fewer than two executions remain, because it could not be confirmed. The two baseline runs and the final control replay are counted separately; `reduction.json` reports all three counts.
- `--deadline-ms` (default 600000, 100..3600000) bounds the whole command, including baseline and control. An execution in progress at the deadline is stopped.
- SIGINT or SIGTERM cancels the current execution and ends the reduction.
- Three consecutive infrastructure errors end the search.

Every attempt is recorded with one outcome:

- `target`: the target was reproduced.
- `no-target`: a complete observation without the target (PASS, or a DIVERGED run that fails one of the checks above; `detail` names which).
- `invalid-sequence`: an operation failed with `ENOENT`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY` or `EEXIST`, for example a `rename` or `delete` whose source was created by a removed step. This says nothing about the divergence.
- `incomplete`: INCONCLUSIVE, NOT-READY, UNSUPPORTED, a snapshot or readiness timeout, the per-run deadline, or an INCONCLUSIVE target checkpoint.
- `infrastructure-error`: any other ERROR.
- `cancelled`: the execution was stopped.

Only `target` confirms a candidate. The classification reads the typed `failure` field and checkpoint data of the run result, never message text.

### Output

`--out` is required and must name a path that does not exist; its parent must exist. Nothing is executed when the path is taken. Files are written to a sibling `<out>.partial-*` directory and renamed into place, so `--out` never contains a partial set.

- `scenario.json`: the last scenario that reproduced the target twice, in the normal scenario format. Absent when the baseline target was never confirmed.
- `control.json`: the complete result of the control replay, when it ran.
- `reduction.json`: the journal, with `status`, `stop`, the adapter command and observation settings, both budgets, `target`, `steps.kept` (original positions of the remaining steps), `verification`, execution counts and all `attempts`.

`verification` states how far `scenario.json` is checked: `control-reproduced`, `confirmed-without-control` (two reproductions, but the deadline, cancellation or an infrastructure stop prevented or interrupted the control), `control-not-reproduced` or `none`.

Statuses and exit codes:

- `reduced` (0): steps were removed and the control replay reproduced the target.
- `unchanged` (0): no step could be removed; the control replay reproduced the target.
- `budget-exhausted` (5): the execution budget ended the search; the control replay reproduced the last confirmed scenario.
- `deadline-exceeded` (5): the deadline ended the command; no control replay completed.
- `not-reproducible` (2): the baseline did not diverge or did not repeat the target, or the control replay did not reproduce it.
- `cancelled` (3).
- `infrastructure-error` (2).

The result is minimal only with respect to the removals that were tried within the budget, and it depends on the platform, adapter and observation settings used. The built-in `broken` consumer is supported on Linux and macOS only; elsewhere its baseline is UNSUPPORTED and the reduction ends as `not-reproducible`.

## Applicability to paths and types

SHA-256 scenarios retain all their checks. With `hash: "none"`, applicability depends on whether the selected disk paths/types changed between checkpoints, after literal excludes and selected types are applied. A step with no observable change is recorded in `result.assertions` with `checked: false` and a reason; it cannot establish content freshness. All-inapplicable scenarios return UNSUPPORTED (CLI exit 4). Mixed scenarios retain only their applicable cache checkpoints and explicitly list the unchecked steps in every report.

- `atomic-save`: neither same-path replacement nor subsequent content edit is applicable. The transient temporary file is gone before the checkpoint.
- `burst`: all writes keep the same path/type, so the scenario is not applicable.
- `recreate`: deletion and recreation are applicable; the final overwrite is not.
- `directory-rename`: moving the subtree is applicable, including in a files-only index; the subsequent content edit is not.
- `delete`: applicable when the deleted file is selected and not excluded.

The same rule covers imported scenarios, directory-only projections and changes outside the declared scope. A group that creates and deletes the same file before its checkpoint has no observable final path change. A non-applicable assertion is distinct from an error or an inconclusive comparison.
