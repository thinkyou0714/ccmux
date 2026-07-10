# ccmux — Improvement Backlog

Scored best-practice backlog from a read-only deep-research sweep (value × effort × risk).
Tiers: **T1** = high-value / low-risk / behavior-preserving (do soon) · **T2** = behavior-preserving
code-quality · **T3** = higher-leverage or behavior-changing (needs design). Status reflects what is
already on `main` at the time of writing.

## Done / not needed (verified against the codebase)
- **Windows SessionStart hook path bug** — `writeSessionStartHook` embedded a raw Windows path; fixed in PR #81 (POSIX-normalize + regression test).
- **`vitest.config.ts` test timeouts** — already present (`testTimeout`/`hookTimeout: 20_000`) to absorb bash/git subprocess flakiness on Windows CI.
- **CI hardening** — CodeQL, secrets-scan, dependency-review already run on PRs; GitHub Actions are SHA-pinned; Renovate is configured. **Do not add Dependabot** (would conflict with Renovate).

## T1 — scaffolding (this PR)
- **`CLAUDE.md`** — layered project guide (Quick Start → Architecture → Commands → Testing → Safety/Guardrails → Extending), accurate to the code.
- **`.claude/settings.json`** — read-only permission allowlist (package scripts + safe git) + destructive-command deny list.

## T2 — behavior-preserving code-quality
- **Structured logger** (`src/core/logger.ts`) — replace ~99 scattered `console.*` across 18 files with `debug/info/warn/error` honoring a `DEBUG=ccmux:*`-style switch; callable from hooks. (value M, effort L, risk low)
- **Validate generated hook scripts at install time** — optional `shellcheck` pass over the 3 generated `.sh` files (skip if shellcheck absent); add a test that all three install + are executable. (M/M/low)
- **Explicit request timeout on n8n handlers** — `req.setTimeout(...)` on `/session/new` + `/webhook/github` to bound slow clients; integration test. (`src/integrations/n8n.ts`) (M/M/low)
- **Typed error classes + codes** (`SessionNotFoundError`, `LockTimeoutError`, `WorktreeError`, `ObsidianError(statusCode)`) so n8n handlers can map to correct HTTP status (404/429/500). (M/M/medium)
- **e2e flow test** — `new → auto → close → merge` against a mock repo + mock LLM, to catch sequencing regressions. (`tests/e2e-workflow.test.ts`) (high/L/medium)
- **Concurrency docs in CLAUDE.md** — per-session lock vs BL-6 SQLite webhook-dedup queue lifecycle. (M/S/low)

## T3 — higher-leverage / behavior-changing (separate PRs, design first)
- **`lock.ts` acquire timeout** — bound the stale-lock retry loop with a max wait + backoff (`CCMUX_LOCK_TIMEOUT_MS`, default ~5s) so a wedged lock can't hang a command. **Behavior-changing** — env-gated, with tests for the timeout path. (`src/core/lock.ts`) (M/M/medium)
- **Shared `net.ts` retry/timeout wrapper** — unify the 3s/5s/10s ad-hoc timeouts in doctor/autoclaw/obsidian behind one retry helper. (M/M/low)
- **Obsidian write retry + local fallback** — on REST failure, retry then fall back to `~/.ccmux/handoffs/<name>.md` instead of failing session close. (M/M/low)
- **Config schema migrations** — versioned migration chain so future field-shape changes don't silently mis-merge old `config.json`. (M/M/medium)
- **Session state integrity check** — `validateSessionState()` (worktree exists / branch exists / lock not stale) used by `getSession` + `prune`. (M/L/low)
- **`--profile` timing breakdown** for long commands (new/auto/close). (low/M/low)

> Generated as part of an ecosystem-wide best-practice sweep. Companion backlogs live in the sibling
> repos (fugu, engineer-tenshoku-navi, denken-os). Cross-cutting standardization (shared CLAUDE.md /
> `.gitattributes` / security-workflow templates) is tracked for the org `.github` repo.
