# Session Handoff — Long-running Tasks branch (PR #21)

> Written: 2026-05-18. Branch: `claude/long-running-tasks-0ErIo` → master.
> Read this BEFORE picking up follow-up work on this PR.

## What was attempted

A super-long-running session was used to draft 410 task specifications
in 5 batches (≈100 tasks each), running with up to 3 parallel
sub-agents per turn. Each sub-agent created a git worktree under
`.claude/worktrees/agent-*` and wrote its spec into
`docs/long-running-tasks/NNN-*.md` on that worktree's branch.

## What survives

- 9 spec files committed to this PR (numbers 22, 172, 180, 230, 244,
  273, 291, 292, 342). Names + 1-2 line summaries for the other ~401
  preserved in `docs/long-running-tasks/000-INDEX.md`.
- This PR's **security hardening** (8 commits, C-01..H-06) — see
  table below.
- 8 new regression test files (64 new vitest tests) preventing
  reintroduction.
- New CI security job (`security` in `.github/workflows/ci.yml`) with
  npm audit + gitleaks + regression tests.

## What was lost

The bulk of the 410 spec bodies. Root cause:

1. `.claude/worktrees/` was added to `.gitignore` (commit `1aec595`,
   `chore: ignore .claude/worktrees/ (background agent worktrees)`) to
   avoid polluting `git status` with hundreds of agent worktrees.
2. The worktree dir itself was later pruned by either `git worktree
   prune` or session-end cleanup hooks.
3. The branches the agents created were never pushed to `origin`
   (push happened only for the 9 specs that were merged into the main
   branch via `git add` from the supervising agent).
4. The conversation context didn't retain full spec bodies — only the
   names and the "key findings" snippets that surfaced in turn output.

**Recovery is not feasible from in-PR data alone.** The names and key
findings in `000-INDEX.md` are reconstructed from conversation history;
that's the salvageable layer.

### Lesson for next time

When using long-running multi-agent worktrees:

- Either keep `.claude/worktrees/` un-gitignored and let `git status`
  noise be the cost,
- Or have the supervising agent **`git push -u origin agent-*`** each
  child branch as soon as the child commits — pruning the worktree dir
  is then non-destructive because the branch lives on origin.

## Security fixes applied in this PR

| ID | File:Line (post-fix) | Fix commit |
|----|----------------------|-----------|
| C-01 | `src/core/zellij.ts:55-78` | `fix(zellij): C-01 use load-buffer/paste-buffer` |
| C-02 | `src/commands/auto.ts:220-244` + new `src/core/loop-daemon.ts` | `feat(loop-daemon): C-02 replace bash heredoc with node detached worker` |
| C-03 | new `src/core/env-scrub.ts` + 3 call sites | `feat(env): C-03 add scrubEnv()` |
| H-01 | new `src/core/session-name.ts` + 3 call sites | `feat(security): H-01 add validateSessionName` (also H-01 boundary in auto commit) |
| H-03 | `src/integrations/n8n.ts:42-65, 208-223` | `fix(n8n): H-03 require authToken` |
| H-04 | `src/commands/auto.ts:33-44, 100, 147, 224` + `src/index.ts:77` | `feat(auto): H-04 make --unsafe-skip-permissions opt-in` |
| H-05 | `src/core/cost.ts:29-54` | `fix(cost): H-05 remove Rikuto fallback` |
| H-06 | `src/integrations/obsidian.ts:42-58` | `fix(obsidian): H-06 default rejectUnauthorized:true` |

For each: see `docs/long-running-tasks/000-INDEX.md` Security findings
table, then the commit message body.

### Behavioural changes users will see

- **ccmux auto** no longer passes `--dangerously-skip-permissions` to
  claude by default. Pass `--unsafe-skip-permissions` to restore old
  behaviour (required for fully-unattended loops).
- **ccmux serve** refuses to start without `n8n.authToken`. Set the
  config field or pass `CCMUX_N8N_ALLOW_NOAUTH=1` for local-dev only.
- **ccmux reflect / dashboard export to Obsidian** now requires either
  a valid TLS cert or `CCMUX_OBSIDIAN_ALLOW_SELFSIGNED=1`.
- **ccmux cost subcommands** no longer assume the username 'Rikuto'
  when WINDOWS_USERNAME / USER are unset on WSL2. Set
  `CLAUDE_CONFIG_DIR` explicitly if your setup needs it.
- **Spawned children** no longer inherit the parent's full `process.env`.
  The allowlist in `src/core/env-scrub.ts` covers PATH/HOME/USER/TERM
  /Windows essentials + `CCMUX_*`. Anything else passed via the
  `extra` arg to `scrubEnv()` (centralised in `buildClaudeEnv`).

## Test coverage added

| File | Covers | Test count |
|------|--------|------------|
| `tests/zellij-send-keys.test.ts` | C-01: load-buffer/paste-buffer; stripCtrl regex | 4 |
| `tests/loop-daemon.test.ts` | C-02: no bash, literal .includes match, dispatch guard | 5 |
| `tests/env-scrub.test.ts` | C-03: secrets blocked, allowlist correctness, override merge | 9 |
| `tests/session-name-validation.test.ts` | H-01: 21 rejects + 9 accepts | 32 |
| `tests/n8n-auth.test.ts` | H-03: no auth-bypass, throw on missing token, opt-out documented | 4 |
| `tests/auto-unsafe-flag.test.ts` | H-04: CLI flag, dangerFlag helper, no unconditional --dangerously- | 5 |
| `tests/obsidian-tls.test.ts` | H-06: strict default, env opt-out gate | 2 |
| `tests/username-detection.test.ts` | H-05: no Rikuto, USERPROFILE first, override priority | 3 |

Run: `npm test -- tests/zellij-send-keys.test.ts ...` or via the CI
security job.

## CI changes

`.github/workflows/ci.yml` now has 2 jobs:

- `ci` (existing): matrix lint + build + unit tests + integration tests
  across ubuntu/windows/macos × node 22.
- `security` (new, this PR): on ubuntu only,
  1. runs the 8 security regression files (blocking),
  2. `npm audit --omit=dev --audit-level=high` (warning-only),
  3. gitleaks scan with `.gitleaks.toml`.

Flip `continue-on-error` on the audit step to `false` once the
dependency baseline is clean.

## Known gotchas for next session

- **`.claude/worktrees/` in `.gitignore` is a trap** when combined with
  agent worktrees: see "What was lost" above.
- **>3 parallel sub-agents** in one turn risks context pollution
  (`rules/agent.md` parallel limit). The cost is hidden until you try
  to track which agent did what; for big sweeps push child branches
  early or run agents serially.
- **`litellm.port` file is not yet wired into `Invoke-Status`** of the
  PowerShell wrapper — Phase 9 helpers are defined but adopted only by
  the skill. Confirm via `~/.claude/skills/litellm-status` rather than
  by raw curl to 3101.
- **codex-review quota awareness** (skill: `codex-review`,
  `manage_suppressions.py promotions`): use `-CheapOnly` /
  `-ProfileFilter` before the full sweep — Plus subscriptions burn
  hours fast.
- **n8n upgrade 1.121.0 → 1.122.5 is now applied** (memory:
  `project_phase63_n8n_upgrade_2026_05_18`). The `activeVersionId
  NULL` bug in 1.121.0 is gone, but any helper script that worked
  around it (e.g. `_n8n_activeversion_helper.py`) should be marked
  no-op rather than deleted in case rollback is needed.

## Next session candidates

In rough priority order (smaller first):

1. **Flip `continue-on-error` on `npm audit`** once baseline is clean.
2. **K115 loopguard MVP** — partner safety net to H-04. The new
   "permissions are not auto-skipped" default makes a stuck loop more
   likely; a SHA-256 / 16-hex / 256-ring detector keeps the cost
   bounded.
3. **K116 OTel env injection** — wire `OTEL_*` env into `scrubEnv()`
   allowlist so observability survives the env scrub.
4. **K117/118 MCP servers (panes/cost/sessions)** — exposes ccmux as
   an MCP server for in-pane introspection.
5. **`feat/sqlite-queue-auto-dashboard-eslint` branch merge** — a
   parallel feature branch is currently open; rebase it on top of
   this PR's master once merged.
6. **CC295 from bare tmux** — turn the migration note in `000-INDEX`
   into a proper user guide.
7. **DD301 cold-start compression** — `zellij.ts:68` hardcoded 300ms
   setTimeout is the biggest single win.

## Decisions worth recording

- **Single PR strategy**: keep this work in PR #21 rather than split
  into "security PR" + "docs PR" + "test PR". Reviewing the security
  fixes alongside the new tests + the INDEX context makes the rationale
  clearer; split would have lost cross-references.
- **Worktree isolation**: implementation happened in a separate git
  worktree (`C:\work\ccmux-lrt`) on a new local branch
  (`work/security`) tracking `origin/claude/long-running-tasks-0ErIo`.
  The original working tree (`C:\work\ccmux` on
  `feat/sqlite-queue-auto-dashboard-eslint`) was never disturbed.
- **C-02 design choice (node detached worker vs bash template file)**:
  picked node worker because (a) it removes the bash dependency on
  Windows hosts entirely, (b) untilPattern can be matched literally
  (`.includes()`) instead of via `grep -F`, (c) it integrates with
  ccmux's existing observability surface (process.stdout → inherited
  log fd).
- **H-04 behavioural break**: chose to break existing `ccmux auto`
  usage rather than carry the unsafe default forever. Migration is one
  CLI flag.
