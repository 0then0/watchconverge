# Changelog

All notable user-facing changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/). Protocol and result-format changes are documented explicitly; the project is currently in its initial 0.x series.

## [0.3.0] - 2026-11-11

### Added

- `reduce` CLI command: bounded, sequential delta debugging that removes whole steps from a diverging scenario while one selected divergence still reproduces at its original checkpoint. Candidates need two reproductions, the result gets an independent control replay, and a new output directory receives `scenario.json`, `control.json` and a `reduction.json` journal. See [reducing a diverging scenario](docs/scenarios.md#reducing-a-diverging-scenario).
- Result JSON additions: step checkpoints carry their zero-based `step` position, and ERROR or NOT-READY results carry a typed `failure` (failed operation with errno code, adapter error code, deadline or cleanup). Existing fields and statuses are unchanged.

### Changed

- Web interface: a compact introduction with a three-step explanation of a run, descriptions under the scenario, adapter and observation-window fields, color-coded run and checkpoint statuses, shortened hashes with the full value in a tooltip, a listed verification scope, larger small text and an export section consistent with the other steps. Statuses, exports and the HTTP API are unchanged.
- Simplified project icon: disk and index entries side by side, with one differing index entry.
- Documentation reorganized for first-time readers: a how-it-works overview and glossary in the README, a message-flow overview and structured result semantics in the protocol reference, and a shorter FFF lab guide.
- The FFF lab runner records whether the working tree was clean or modified.

## [0.2.0] - 2026-10-26

### Added

- Explicit paths/types-only and SHA-256 projections, with strict validation and matching independent disk projections. Existing SHA-256 adapters retain their behavior.
- Per-step applicability and visible verification scope in CLI, UI, JSON and HTML. Content-only steps cannot imply content freshness in paths-only mode; all-inapplicable scenarios return UNSUPPORTED.
- Optional, hash-pinned fff-search 0.11.0 Python lab using the real cached file index, complete bounded snapshots and separate temporary databases/logs. Python is not an application runtime dependency.
- Portable FFF results for three repetitions of create, delete, directory rename and recreate, including static-index negative controls and sandbox failures.
- Explicit unavailable revision/processing signals. Such snapshots remain INCONCLUSIVE and cannot produce PASS; legacy adapters retain the required reported-signal contract.

### Fixed

- FFF adapter now observes stdin EOF while waiting for scan/watcher readiness and releases its native index and temporary resources. Added real-index lifecycle tests for EOF, stop and SIGTERM.
- FFF adapter treats only expected SDK and stream failures as fatal diagnostics instead of catching every exception.
- Added a regression test for a paths-only PASS over a real consumer's cache, with content-only assertions explicitly omitted.

### Limitations

- FFF's public SDK does not expose index revision or watcher-queue idle state. Watched runs remain INCONCLUSIVE even when their paths match; full strict idle-convergence verification is not claimed.
- The optional FFF lab was tested only on macOS arm64. Its ignored-path policy is not translated into implicit verifier exclusions, and its recorded fixtures use ordinary visible files in non-git trees.
- Protocol v1 is extended additively. Older runners reject the new projection or null signals rather than silently weakening validation. PASS remains limited to applicable selected-projection checkpoints.

## [0.1.0] - 2026-10-25

### Added

- Shared CLI and local web runner for five real filesystem scenarios: atomic replacement, recreation, directory rename, overwrite bursts and deletion.
- Independent disk/index comparison for relative paths, regular-file/directory types and SHA-256 content, with explicit exclusions and bounded checkpoint observation.
- Versioned JSONL adapter protocol with readiness, request IDs, cached snapshots, diagnostics, processing observations and bounded shutdown.
- Broken inode-bound and directory-invalidation example consumers using real watcher APIs.
- Operation and observation timeline, concrete differences, cancellation, scenario import, and system/light/dark themes.
- Scenario JSON, result JSON and offline standalone HTML exports bound to the displayed run.
- Reproducible Bun #36328 case study with isolated Linux release-binary evidence and platform limitations.
- Unit, protocol, HTTP, CLI, integration and browser validation; CI on Linux, macOS and Windows with Node 22 and 24.
- Public contribution and security guidance, issue/PR templates, Biome and monthly Dependabot checks.

### Limitations

- PASS applies only to the selected projection and checked checkpoints. Event counts and timing are not acceptance criteria.
- The inode-bound demonstration is unsupported on Windows. Custom adapters are trusted processes, not sandboxes.
- Only local regular files and directories are modeled; symlinks, network filesystems and arbitrary existing target trees are outside scope.

[0.3.0]: https://github.com/0then0/watchconverge/releases/tag/v0.3.0
[0.2.0]: https://github.com/0then0/watchconverge/releases/tag/v0.2.0
[0.1.0]: https://github.com/0then0/watchconverge/releases/tag/v0.1.0
