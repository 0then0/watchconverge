# WatchConverge adapter protocol v1

An adapter is a trusted child process launched as an argv array, without a shell, with cwd set to the runner's fresh OS temporary tree. It has the user's normal process permissions. The protocol is not a sandbox. Its fixture access should be read-only; do not alter the tested files. Close any watchers and child processes on stop or stdin EOF.

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

Symlinks are never traversed or included; special files are outside v0.2's model. The verifier records skipped disk paths. Other metadata is ignored and not verified. For example, a paths-only file index declares `{"paths":"relative-posix","types":["file"],"hash":"none","excludes":[]}` and exports `{"path":"src/app.txt","type":"file"}`. Directory entries are not reconstructed from filenames; omit `directory` from `types` if the consumer does not expose directories. Snapshot entries are reduced to the declared path/type/hash projection before retention.

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

An additive v1 extension allows a `ready` response to explicitly declare `"snapshotSignals": "unavailable"`. In that mode **both** `revision` and `processing` must be explicit JSON `null` on every snapshot. The adapter must still establish initial scan completion and watcher startup before ready. This declaration does not permit missing fields, inferred idle state, revision counters derived from snapshot requests, or weakening hash validation.

Omitting `snapshotSignals` preserves the existing strict `reported` contract; an explicit `"reported"` is equivalent. Unknown declarations, nulls without the declaration, or invented boolean/numeric signals in unavailable mode are protocol errors. The declaration is fixed for the run.

Unavailable signals always produce INCONCLUSIVE checkpoints, even when data matches. Repeated differences are retained but cannot establish idle DIVERGED; they may still reflect unfinished processing. A data-equal initial sample at the end of the baseline window allows subsequent operations solely to collect evidence; the baseline remains INCONCLUSIVE. A mismatching initial view remains NOT-READY and prevents operations. No unavailable-signal run can be PASS. Use this mode to expose a public SDK limitation, not conceal it. Do not map `is_scanning` (an initial/full scan flag) or absence of callbacks to a watcher-queue idle assertion.

These are compatible extensions for existing SHA-256 adapters and scenarios: their wire messages and strict result behavior are unchanged. Older runners reject the new paths projection or null signals rather than interpreting them with weaker checks.

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

After writes stop, each checkpoint independently walks disk with the declared projection, then samples the existing cache. A match within the window with no pending processing ends that checkpoint early. Otherwise repeated sampled idle mismatches across the observation window are DIVERGED, while pending processing, a late matching response or only one mismatching sample is INCONCLUSIVE. The initial checkpoint gates readiness. Any diverged checkpoint makes the final run DIVERGED even if later checkpoints match; processing uncertainty cannot erase an already observed divergence.

Timeout alone never proves notification loss. PASS applies only to this projection and the applicable checked steps, with reported idle signals. For `hash: "none"`, a step whose final selected paths/types are unchanged from the preceding disk checkpoint is marked not applicable and has no cache checkpoint. This includes content-only overwrites, as well as any net-zero or entirely excluded path changes. Operations still execute; intermediate states within a step are not asserted. If every step is inapplicable the existing UNSUPPORTED status is used, never PASS. Mixed scenarios may PASS only the explicitly checked path assertions; content freshness is outside their scope. Results retain `projection`, `snapshotSignals`, `limitations` and per-step `assertions` (`step`, `checked`, `reason`) in JSON, CLI, UI and HTML. No new run status is introduced. It says nothing about other metadata, unseen intervals, other operating systems or all possible watcher races.
