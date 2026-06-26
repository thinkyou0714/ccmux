# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's **Report a vulnerability**
flow (Security → Advisories) on [thinkyou0714/ccmux](https://github.com/thinkyou0714/ccmux),
or by opening a minimal private advisory rather than a public issue. Include
repro steps and the affected version (`ccmux --version`). We aim to acknowledge
within a few days.

## Trust model

ccmux orchestrates **autonomous** Claude Code sessions, some launched with
`--dangerously-skip-permissions`. Treat any input that reaches an autonomous
run as capable of driving the agent. The boundaries below are the ones the code
enforces; understand them before exposing the `serve` daemon beyond localhost.

### Webhook lane (`ccmux serve` → `/webhook/github`)

- **Authentication is fail-closed.** `/webhook/github` is *disabled* (HTTP 503)
  unless `n8n.webhookSecret` is set. Requests are authenticated by constant-time
  HMAC-SHA256 over the raw body (`X-Hub-Signature-256`) **before** any routing
  decision, so an unauthenticated caller cannot probe accepted events or reach
  the agent.
- **Untrusted input is sandboxed by default.** A GitHub issue title/body is
  attacker-controlled and is fed to an autonomous run, so webhook runs require
  the bubblewrap OS sandbox (Linux + `bwrap`). When the sandbox cannot be applied
  the run is **refused** (503), not executed unsandboxed. The
  `CCMUX_WEBHOOK_ALLOW_UNSANDBOXED=1` escape hatch removes this protection — do
  not set it for internet-reachable deployments.
- **DoS bounds.** Request bodies are capped at 1 MiB (Content-Length *and*
  streaming byte count); the server sets `headersTimeout`/`requestTimeout`/
  `keepAliveTimeout` against slowloris. The dedup queue ensures a redelivered
  issue spawns at most one session.
- **Bind scope.** The server binds `127.0.0.1` only. Expose it via a trusted
  reverse proxy with TLS, never directly.

### Session names → filesystem & git

Session names become both worktree directory segments and git branch names, so
they are validated (`validateSessionName`): a conservative charset, no `..`/`.`
segments, no absolute paths, no leading `-` (git option injection). Git commands
that take user-derived values use array args (no shell) and an `--` option
terminator.

### Agent containment hooks

Autonomous sessions install a `PreToolUse` hook that canonicalizes paths and
**fails closed** if a write would escape the worktree boundary, plus a
destructive-command blocklist. The blocklist is defense-in-depth, **not** a
trust boundary — the bubblewrap sandbox is the real containment.

### Secrets at rest & in transit

`~/.ccmux/config.json` holds secrets (`n8n.authToken`/`webhookSecret`,
`obsidian.apiKey`, `autoclaw.authToken`). It is written `0600` and re-tightened
on every save; `ccmux doctor` warns when it is group/other-readable. Obsidian
requests verify TLS by default so the Bearer key cannot leak to a MITM; the
`allowInsecureTLS` opt-out logs a warning on every request.

## Supported versions

ccmux is pre-1.0 (`0.x`). Only the latest released version receives security
fixes.
