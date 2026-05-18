# Task 230 — ccmux Compatibility Shim for Aider Workflows

**Date**: 2026-05-18
**Scope**: Design (no source changes) a compatibility shim that lets `ccmux`
host Aider sessions alongside its Claude Code sessions — covering pane
launch, git diff capture, `/diff` and `/undo` passthrough, and the
architect/editor split. No source modifications; no push. This document
captures the design only.

---

## 1. Why an Aider adapter

ccmux is currently Claude-Code-first: `src/commands/new.ts` resolves a
`claudeCmd` via `resolveClaudeCmd(llm)` where `llm` is `"claude" |
"autoclaw"`, then launches that command inside a Zellij tab anchored to
a fresh git worktree. Aider is the second-most-cited CLI in 2026 team
surveys (Task 180) and the canonical CLI for "git-native" workflows: it
commits after every edit, supports an architect/editor model split, and
exposes first-class `/diff`, `/undo`, `/commit`, and `/run` slash
commands. Teams that have standardised on Aider for `git`-disciplined
editing want the same parallel-session ergonomics ccmux already gives
Claude Code users.

The shim deliberately does **not** try to abstract Aider behind
`resolveClaudeCmd`. Aider's prompt loop, slash-command surface, and
auto-commit behaviour are different enough that the right abstraction
is "a second backend kind", not "another claude variant". Concretely:
extend the `llmBackend` enum (today `"claude" | "autoclaw"`) with
`"aider"` and `"aider-architect"`, and route those to a small adapter
module under `src/integrations/aider.ts`.

## 2. Launching Aider in a ccmux pane

The launch contract that already works for Claude Code is:

1. `createWorktree(name, project.path)` makes
   `<worktreeBase>/<name>/` on a fresh branch.
2. `openSession(...)` opens a Zellij tab pinned to that path.
3. The first command in the tab is the LLM CLI.

Aider slots in at step 3. The adapter's `resolveAiderCmd(opts)` should
return a fully-formed shell string:

```
aider --yes-always \
      --no-auto-commits=false \
      --git \
      --gitignore \
      --map-tokens 1024 \
      --model "$AIDER_MODEL" \
      --weak-model "$AIDER_WEAK_MODEL" \
      --read CONVENTIONS.md \
      --read CLAUDE.md
```

Key choices:

- **`--git --gitignore`** — Aider must own commits inside the worktree;
  ccmux's branch is disposable so auto-commit is safe and gives us the
  `/undo` semantics described in §4.
- **`--read CLAUDE.md`** — reuse the existing per-project context file
  that `ccmux swap` already manages. No second context file to maintain.
- **`--map-tokens 1024`** — Aider's repo map; cheap, and the worktree
  is scoped so the map stays small.
- **Model env vars, not flags baked in.** `~/.ccmux/config.json` gains
  an optional `aider: { model, weakModel, editFormat }` block; the
  adapter exports those as env vars before exec so the user can swap
  per-project (e.g. Sonnet 4.7 for editor, Opus 4.7 for architect).

The launch sequence reuses `openSession` unchanged: the Zellij layout
already runs an arbitrary first command in the pane. The only new code
is in `src/integrations/aider.ts` (mirror of `autoclaw.ts`) and a one-
line switch in `new.ts` to route the `"aider"` backend through it.

## 3. Capturing git diffs from an Aider session

Aider auto-commits after each accepted edit, which is gold for ccmux's
existing handoff layer. Today, `ccmux close <name>` writes an Obsidian
handoff note from the session record; the obvious extension is a
`diffSummary` field captured at close-time. The adapter doesn't need to
intercept Aider's edits — git already has them.

Capture path:

1. At session creation, record the baseline commit SHA on the worktree
   branch (`git rev-parse HEAD`) into the session record.
2. At `ccmux close`, compute `git log --oneline <baseline>..HEAD` and
   `git diff --stat <baseline>..HEAD` from the worktree path.
3. Push both into the existing Obsidian handoff template under a
   "## Aider commits" section, plus a fenced diffstat block.

Two cross-cutting concerns:

- **Author attribution.** Configure the adapter to set
  `GIT_AUTHOR_NAME="aider (ccmux:<name>)"` so commits are
  distinguishable from human commits when the branch is later
  merged/squashed. This is purely cosmetic but matters for blame
  archaeology.
- **`/run` side-effects.** Aider's `/run` shells out and can mutate the
  tree without a commit. The handoff capture should also stash any
  uncommitted changes (`git stash push -u -m "ccmux-handoff-<name>"`)
  before close, then surface the stash ref in the note. Don't drop it.

This is the entire diff-capture story. No Aider-specific hook is
required; we are letting Aider be Aider and reading the result through
git.

## 4. `/diff` and `/undo` passthrough

Aider's `/diff` and `/undo` are in-process slash commands handled by
Aider itself — they Just Work inside the Zellij pane, no shim required.
What ccmux needs to add is **outside-the-pane** equivalents so the
user, or a second ccmux session, can query and unwind from another tab
without attaching to the Aider REPL.

Proposed thin wrappers (new `src/commands/aider.ts`, dispatched from
`index.ts`):

- `ccmux aider diff <name>` — runs
  `git diff <baseline>..HEAD -- $(git -C <wt> rev-parse --show-toplevel)`
  from outside the pane. Useful for a reviewer or for `n8n` automations
  that want to PR-ify a worktree without touching the Aider session.
- `ccmux aider undo <name> [--n=1]` — runs
  `git -C <wt> reset --hard HEAD~<n>` after taking a safety tag
  (`ccmux-undo-<name>-<unixts>`). This mirrors Aider's `/undo` but
  works when the REPL has already exited or is stuck mid-thought, and
  it never undoes past the baseline SHA from §3.
- `ccmux aider commits <name>` — `git log --oneline <baseline>..HEAD`,
  effectively the dry-run preview the handoff note will produce.

The Zellij-side `/diff` and `/undo` keep working inside the pane;
ccmux's wrappers are strictly additive and aimed at the "I'm in
another tab / I'm a daemon" case. Importantly the wrappers must refuse
to act on a session whose Aider pane is still running an in-flight
edit; the check is a `flock` on the same lockfile `acquireLock(name)`
already uses, so the existing lock layer extends for free.

## 5. Architect/editor split

Aider's killer team feature is `--architect`: a strong model proposes
edits, a weaker (and cheaper, faster) model applies them as diffs. The
ccmux mapping is two cooperating sessions on one worktree, which is
exactly what worktrees were designed to make safe — *except* both
processes would race on the same working tree if naively co-located.

The shim design:

1. **One worktree, two panes.** The "architect" and "editor" run in
   two Zellij panes inside the same tab, both pointed at the same
   worktree. The architect runs `aider --architect --model
   $ARCHITECT_MODEL`; the editor is launched by the architect through
   Aider's built-in subprocess flow, so ccmux doesn't actually spawn
   two Aiders. The second pane is for **observability** — it tails
   `.aider.chat.history.md` and `git log -p`.
2. **`ccmux new <name> --llm aider-architect`** triggers the
   two-pane layout. The Zellij layout file is a sibling of the
   existing default; the adapter selects it based on the `llmBackend`.
3. **Cost accounting** (`ccusage` integration already in `core/cost.ts`)
   needs an Aider hook. Aider writes
   `.aider.llm.history` with token counts per turn; the adapter's
   `summariseCost(sessionDir)` parses that file and slots into the
   same `ccmux list` cost column. Architect+editor turns get summed.
4. **Concurrency vs other ccmux sessions.** The lock layer already
   prevents two ccmux operations on the same `name`. Across sessions
   there is no contention because each session lives in its own
   worktree branch — exactly the property that makes parallel agents
   tractable in the first place (Task 172, Task 180).

The alternative — running architect and editor in separate ccmux
sessions on separate worktrees and merging — was rejected. It doubles
the merge cost, defeats Aider's per-turn handoff, and loses the shared
chat history.

## 6. Failure modes and what the shim explicitly does **not** do

- **Doesn't proxy Aider's REPL.** No PTY interception; Zellij already
  handles the terminal. The shim is a launcher + git observer, nothing
  more.
- **Doesn't reformat Aider's commits.** Some teams have strict
  conventional-commit policies; rewriting at handoff is the user's job
  (or a post-receive hook). The adapter just labels the author.
- **Doesn't auto-resolve merge conflicts.** If the worktree branch
  conflicts with the project default branch, `ccmux close` surfaces it
  in the handoff note and leaves the worktree on disk, same policy as
  today's Claude Code sessions.
- **Doesn't try to share context with a Claude Code session.** Cross-
  agent context sharing belongs in the Obsidian handoff layer (Task
  series 100s), not in the launcher.

## 7. Rollout plan (no code in this task)

1. Add `aider` and `aider-architect` to the `llmBackend` enum.
2. New file `src/integrations/aider.ts` mirroring `autoclaw.ts` shape.
3. New file `src/commands/aider.ts` for `diff` / `undo` / `commits`.
4. Extend `~/.ccmux/config.json` schema (`config/schema.ts`) with an
   optional `aider` block; default model from env.
5. Extend the Obsidian handoff template with the Aider section.
6. Update `README.md` install notes: `pip install aider-chat` and the
   minimal config block.

Estimated surface: ~250 lines new, zero rewrites. Risk is contained to
the new backend; existing Claude Code sessions are untouched because
the backend branch is selected before any shared code path runs.

---

**Status**: design complete; implementation deferred to a follow-up
task. This document is the design artifact for Task 230.
