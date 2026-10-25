# Security policy

## Supported versions

Security fixes target the latest published 0.1.x release and the main branch. Older versions are not maintained separately. Update to the latest patch release before reproducing an issue.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/0then0/watchconverge/security/advisories/new) for suspected vulnerabilities. Do not disclose exploit details, secrets or private adapter logs in a public issue. Include the affected version, operating system, Node version, minimal reproduction and expected impact. Use disposable fixtures and redact personal paths and credentials.

Reports are reviewed by the project maintainer; there is no guaranteed response time or paid bounty program. Coordinate public disclosure through the private report after a fix is available.

## Trust boundaries

WatchConverge is a local development tool. The HTTP server binds to loopback and validates Host, Origin and mutation headers. Do not expose it through a public proxy or port forward.

Custom adapters are explicitly launched trusted code with your process permissions, not sandboxed plugins. Only run adapters you trust. Scenario operations use tool-owned temporary trees; the regular-file/directory model does not traverse symlinks. Adapter commands and diagnostics can appear in exported reports, so review exports before sharing them.

A convergence PASS checks a selected projection and scenario; it is not a security assessment of an adapter or filesystem. See [README](README.md) for operational limits.
