# Changelog

All notable user-facing changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/). Protocol and result-format changes are documented explicitly; the project is currently in its initial 0.x series.

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

[0.1.0]: https://github.com/0then0/watchconverge/releases/tag/v0.1.0
