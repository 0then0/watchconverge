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

## Applicability to paths and types

SHA-256 scenarios retain all their checks. With `hash: "none"`, applicability depends on whether the selected disk paths/types changed between checkpoints, after literal excludes and selected types are applied. A step with no observable change is recorded in `result.assertions` with `checked: false` and a reason; it cannot establish content freshness. All-inapplicable scenarios return UNSUPPORTED (CLI exit 4). Mixed scenarios retain only their applicable cache checkpoints and explicitly list the unchecked steps in every report.

- `atomic-save`: neither same-path replacement nor subsequent content edit is applicable. The transient temporary file is gone before the checkpoint.
- `burst`: all writes keep the same path/type, so the scenario is not applicable.
- `recreate`: deletion and recreation are applicable; the final overwrite is not.
- `directory-rename`: moving the subtree is applicable, including in a files-only index; the subsequent content edit is not.
- `delete`: applicable when the deleted file is selected and not excluded.

The same rule covers imported scenarios, directory-only projections and changes outside the declared scope. A group that creates and deletes the same file before its checkpoint has no observable final path change. A non-applicable assertion is distinct from an error or an inconclusive comparison.
