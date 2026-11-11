# WatchConverge adapter protocol v1

An adapter connects an indexer to WatchConverge. It starts the indexer on a directory chosen by the runner, reports when the index is ready, and returns the index's current cached contents whenever the runner asks. The runner compares those contents with its own walk of the disk.

A run exchanges messages in this order:

1. The runner sends `init` with the tree to index. The adapter answers `ready` and declares what its snapshots contain.
2. The runner sends `snapshot` requests, first to check the initial index and then after each scenario step. The adapter answers each with its cached entries.
3. At any time the adapter may send `event`, `processed` and `diagnostic` observations. They are recorded as evidence and do not decide the result.
4. The runner sends `stop`. The adapter answers `stopped` and exits with code 0.

The [built-in consumers](../src/adapters/demo.mjs) are complete working adapters of about 150 lines.

## Process and transport

An adapter is a trusted child process launched as an argv array, without a shell, with its working directory set to the runner's new temporary tree. It has the user's normal process permissions; the protocol is not a sandbox. Treat the tree as read-only and do not alter the tested files. Close any watchers and child processes on stop or stdin EOF.

Transport is UTF-8 JSONL over stdin/stdout, one JSON object per newline. Every message has `v: 1` and a `type`. Put application logs on stderr, which is captured separately as diagnostics. Do not print banners to stdout. Each line must be newline terminated; a non-empty partial line at EOF is a protocol error. The stdout buffer limit is 1 MiB and a snapshot is limited to 10,000 entries. The runner retains at most 15,000 observations per run. Envelope errors, unknown versions/types, unexpected or duplicate IDs and fatal diagnostics are errors.

## Initialization and readiness

Runner → adapter:

```json
{ "v": 1, "type": "init", "id": "r1", "root": "/absolute/owned/temporary/tree" }
```

Adapter → runner, using the **same** request ID:

```json
{
  "v": 1,
  "type": "ready",
  "id": "r1",
  "projection": {
    "paths": "relative-posix",
    "types": ["file", "directory"],
    "hash": "sha256",
    "excludes": []
  }
}
```

Initialize the actual index and create its watcher subscriptions before declaring readiness. `ready` is the adapter's assertion, not an OS guarantee. The runner independently checks that the initial cache matches disk before any scenario writes. An initial scan is allowed; snapshot-triggered scans are not. If ready is absent at its deadline (default 5,000 ms), the result is NOT-READY. Invalid ready responses and process failures are ERROR. A ready response without a matching baseline is NOT-READY.

The projection is fixed for the whole run:

- `paths`: exactly `relative-posix`. Paths are case-sensitive keys, even if the host filesystem folds case. The root entry is omitted. Use `/` separators on Windows too. Absolute paths, drive prefixes, backslashes, control characters, empty components, `.` and `..` are rejected. Maximum path length is 1,024 characters.
- `types`: a non-empty, duplicate-free subset of `file`, `directory`. Both are default. Directory contents are represented by their own entries, not a directory hash.
- `hash`: required, exactly `sha256` or `none`. `sha256` requires 64 lowercase hexadecimal characters over the raw bytes of every regular file. `none` selects paths and types only: file entries need no hash and disk verification does not read file content. Missing, null or unknown `hash` is a protocol error, never an implicit downgrade. If a file hash is supplied in either mode it must be valid; valid hashes in `none` are discarded before comparison and retention.
- `excludes`: up to 100 canonical relative path prefixes. A prefix excludes itself and descendants separated by `/`. `build` excludes `build/a`, but not `builder/a`. No globs, normalization, case-folding or implicit exclusions. The runner applies these prefixes to **both** disk and cached view. The adapter may omit excluded entries.

Symlinks are never traversed or included; special files are outside the file model. The verifier records skipped disk paths. Other metadata is ignored and not verified. For example, a paths-only file index declares `{"paths":"relative-posix","types":["file"],"hash":"none","excludes":[]}` and exports `{"path":"src/app.txt","type":"file"}`. Directory entries are not reconstructed from filenames; omit `directory` from `types` if the consumer does not expose directories. Snapshot entries are reduced to the declared path/type/hash projection before retention.

## Snapshot requests

Runner → adapter:

```json
{ "v": 1, "type": "snapshot", "id": "r2" }
```

Adapter → runner:

```json
{
  "v": 1,
  "type": "snapshot",
  "id": "r2",
  "revision": 7,
  "processing": false,
  "entries": [
    { "path": "src", "type": "directory" },
    {
      "path": "src/app.txt",
      "type": "file",
      "hash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    }
  ]
}
```

Return a consistent copy of the **existing index**, with at most one entry per path. Do not full-scan, reconcile, restart a watcher or otherwise repair state because of a snapshot request. Export the indexer's own cached view, not a separate filesystem-backed facade. An ordinary event-driven reconciliation is allowed independently of snapshot requests and must report whether it is pending.

`revision` is a non-negative, monotonically non-decreasing safe integer describing index updates. It is not a filesystem event count and has no relationship to runner operation numbers. `processing` is a required boolean describing the consumer's processing queue. Set it true while known work is pending, and publish a completed revision after processing. False is an idle assertion, not proof that all OS events arrived. Equal snapshots with `processing: true` cannot establish a checkpoint match.

### Consumers without observable completion signals

Some indexers cannot report an index revision or whether work is pending. For them, a `ready` response may declare `"snapshotSignals": "unavailable"`. In that mode **both** `revision` and `processing` must be explicit JSON `null` on every snapshot. The adapter must still establish initial scan completion and watcher startup before ready. This declaration does not permit missing fields, inferred idle state, revision counters derived from snapshot requests, or weakening hash validation.

Omitting `snapshotSignals` means `"reported"`, the default contract described above; an explicit `"reported"` is equivalent. Unknown declarations, nulls without the declaration, or invented boolean/numeric signals in unavailable mode are protocol errors. The declaration is fixed for the run.

Unavailable signals always produce INCONCLUSIVE checkpoints, even when data matches. Repeated differences are retained but cannot establish idle DIVERGED; they may still reflect unfinished processing. A data-equal initial sample at the end of the baseline window allows subsequent operations solely to collect evidence; the baseline remains INCONCLUSIVE. A mismatching initial view remains NOT-READY and prevents operations. No unavailable-signal run can be PASS. Use this mode to state an indexer's limitation openly. Do not derive an idle assertion from an initial-scan flag or from the absence of callbacks.

### Request rules and deadlines

The runner permits one snapshot request at a time. Responses must echo its exact request ID. A snapshot has a default 1,500 ms response deadline; missing/malformed/late responses beyond the **request** deadline are infrastructure/protocol errors. A response that arrives within its request deadline but matches only after the **observation window** is inconclusive. It cannot produce PASS. No new snapshot is initiated after the observation window ends. An in-flight request can extend the elapsed checkpoint duration by its own bounded deadline.

## Observations, independent of responses

Adapter → runner, without request IDs:

```jsonl
{"v":1,"type":"event","event":"rename","path":"app.txt","watched":"."}
{"v":1,"type":"event","event":"change","path":null,"watched":"src"}
{"v":1,"type":"processed","revision":8,"reason":"directory invalidation reconciliation"}
{"v":1,"type":"diagnostic","level":"info","message":"watch subscriptions created"}
```

- `event`: raw watcher observation. `event` is a string and `path` is a string or null; null can mean directory invalidation without a filename. Raw paths here are evidence, not canonical snapshot keys.
- `processed`: processing completion with non-negative safe integer `revision`; `reason` is optional descriptive data. Emit after applying watcher work to the index. This is neither a raw event nor a comparison result.
- `diagnostic`: `level` is `info`, `warn` or `error`; `message` is a string. An error diagnostic is fatal and terminates the run as ERROR. stderr is diagnostic text, not a protocol response.

Observations may interleave with request responses. Repeated/coalesced notifications and subtree invalidations are normal. The runner neither requires one event per operation nor derives correctness from event counts, filenames or order. Event/processing observations make the trace useful but only cached snapshots and independent disk state decide comparison results.

## Shutdown and process failure

Runner → adapter:

```json
{ "v": 1, "type": "stop", "id": "r9" }
```

Adapter → runner:

```json
{ "v": 1, "type": "stopped", "id": "r9" }
```

Acknowledge, close watchers, stop owned children, close stdin handling and exit with code **0**. Acknowledging stop does not conceal a subsequent nonzero exit or signal: either makes an otherwise healthy run ERROR.

The stop-response deadline is 400 ms. After acknowledgment, the runner allows 200 ms for exit, then sends SIGTERM and waits 300 ms, then SIGKILL and waits 500 ms. Requiring forced termination after an otherwise healthy stop is a cleanup error. A missing or invalid acknowledgment is also ERROR even if termination succeeds.

Already failed or cancelled processes are terminated without requiring another valid protocol exchange. Expected termination during cancellation preserves STOPPED; a process that still cannot be terminated is a cleanup error. Termination targets the direct child, so adapters must manage their own descendants.

Spawn failure, unexpected exit (even exit 0 during a request), broken stdin, invalid JSONL and snapshot deadline expiration reject pending requests immediately or at a bounded deadline. User cancellation interrupts pending readiness/snapshot requests and yields STOPPED; a 120-second overall run deadline yields ERROR. The runner removes its fixture tree in `finally`, including protocol and filesystem error paths. Cleanup failures override successful comparisons as ERROR and include the retained root path in the result.

## Result semantics

### Checkpoints

After writes stop, each checkpoint walks the disk independently with the declared projection, then samples the existing cache until the observation window ends.

- **Match**: a snapshot equals the disk within the window and reports no pending processing. The checkpoint ends early.
- **Diverged**: at least two idle snapshots differed from the disk and the last sample in the window still did.
- **Inconclusive**: processing was pending or unavailable, a matching response arrived after the window, or only one mismatching idle sample arrived.

The initial checkpoint gates readiness: without a matching initial index the run is NOT-READY and no scenario operation starts.

### Run status

- Any diverged checkpoint makes the run DIVERGED, even if later checkpoints match. Processing uncertainty cannot erase an observed divergence.
- Otherwise any inconclusive checkpoint makes the run INCONCLUSIVE.
- PASS requires a match at every checked checkpoint, with reported idle signals. It applies only to the declared projection and the checked steps. It says nothing about other metadata, unseen intervals, other operating systems or all possible watcher races.
- A timeout alone never proves notification loss.

### Steps without an applicable check

With `hash: "none"`, a step whose selected paths and types are unchanged from the preceding disk checkpoint is marked not applicable and has no cache checkpoint. This covers content-only overwrites and any net-zero or entirely excluded path changes. The operations still execute; intermediate states within a step are not asserted. If every step is inapplicable, the run is UNSUPPORTED, never PASS. A mixed scenario can PASS only its checked path assertions; content freshness is outside its scope.

### Result fields

Result JSON, the CLI, the UI and the HTML report retain `projection`, `snapshotSignals`, `limitations` and per-step `assertions` (`step`, `checked`, `reason`).

Each step checkpoint carries `step`, its zero-based position in `scenario.steps`; the initial checkpoint has none. ERROR and NOT-READY results carry a typed `failure` when the cause is known:

- `operation`: a scenario operation failed, with `step`, `operation` and the errno `code`.
- `adapter`: a protocol or process failure, with the adapter error `code`, for example `ready-timeout`, `request-timeout`, `protocol` or `exit`.
- `deadline`: the 120-second run deadline expired.
- `cleanup`: the adapter or the temporary tree could not be cleaned up.
- `internal`: any other failure.

Read `failure` and checkpoint data instead of parsing `message`, whose wording may change.

## Compatibility

Every message carries `v: 1`. The paths-only projection (`hash: "none"`) and `snapshotSignals` were added in WatchConverge 0.2.0 without changing the messages or results of SHA-256 adapters. A 0.1.0 runner rejects both instead of applying weaker checks.
