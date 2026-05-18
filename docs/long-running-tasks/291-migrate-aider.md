# Task 291 — Migration Guide: Aider to ccmux

**Date**: 2026-05-18
**Scope**: Document a pragmatic, low-risk migration path for an existing
Aider user adopting `ccmux`. Map Aider's day-to-day slash commands
(`/add`, `/drop`, `/diff`, `/undo`, plus the supporting cast) to ccmux
equivalents, and describe the transitional pattern of running Aider
*inside* a ccmux Zellij pane while the user's muscle memory catches up.
No source modifications; companion to the Task 230 adapter design.

---

## 1. Why migrate at all

Aider is excellent at the single-loop case: one repo, one chat, one
agent that auto-commits after each edit. ccmux is built for the
multi-loop case: several worktrees, several Claude Code (or Aider)
sessions, an Obsidian handoff layer, and a daemon (`ccmux auto`) that
keeps long-running tasks moving while the human is elsewhere. The two
tools are not in opposition — ccmux can host Aider as a backend (Task
230) — but the workflows differ enough that a straight "use the same
commands" pitch would mislead. This guide is for the user who has spent
six months in Aider and wants to keep the parts that work while
graduating to parallel sessions.

The migration is **transitional by design**: Phase 1 keeps Aider as the
in-pane REPL and adds ccmux around it. Phase 2 swaps the REPL for
Claude Code where the slash-command muscle memory hurts least. Most
teams sit on Phase 1 for weeks before moving; that is fine.

## 2. Command-by-command mapping

The table below is the load-bearing artifact of this doc. Read it once;
keep it near your keyboard for a week.

| Aider command | What it does | ccmux equivalent | Notes |
|---|---|---|---|
| `/add path` | Add a file to chat context | (in pane) still `/add`; **or** rely on Claude Code's implicit `@path` mention; **or** `ccmux swap <project>` to switch the whole `CLAUDE.md` | ccmux scopes context per-worktree, so the "what files are in chat" question collapses into "what's in this branch". |
| `/drop path` | Remove a file from context | (in pane) `/drop`; otherwise restart the CC pane — context is per-session | Claude Code has no `/drop`; closing the pane and reopening with a narrower `CLAUDE.md` is the idiomatic move. |
| `/diff` | Show pending edits | `ccmux aider diff <name>` (Task 230 wrapper) or plain `git diff` from any tab | The wrapper works from a *different* Zellij tab, which is the whole point — review while the agent keeps editing. |
| `/undo` | Revert last commit | `ccmux aider undo <name>` or `git reset --hard HEAD~1` in the worktree | The ccmux wrapper takes a safety tag first and refuses to cross the session's baseline SHA. |
| `/commit` | Commit pending edits | n/a — ccmux sessions auto-commit at `close` time via the worktree boundary; for in-flight commits, just run `git commit` | Aider's per-turn commit becomes ccmux's per-session commit. Granularity moves up one level. |
| `/run cmd` | Shell out, attach output | Open a second Zellij pane (`Ctrl-p n`) and run it there | Aider folded shell into the REPL because there was one pane. ccmux gives you N panes; use them. |
| `/test` | Run tests, attach failures | Same — second pane, plus the `SessionStart` hook can run a smoke suite when the tab opens (see `session-start-hook` skill) | The hook approach removes the "did I remember to run tests" question entirely. |
| `/architect` | Strong-model proposes, weak-model edits | `ccmux new <name> --llm aider-architect` (Task 230) | The two-pane layout puts the architect REPL on top and a `git log -p` tail beneath it. |
| `/ask` | Question without editing | Claude Code default mode is "ask"; toggle edit with `Shift-Tab` in CC's UI | Aider conflates ask and edit behind a mode flag; CC inverts the default. |
| `/clear` | Reset chat history | Close and reopen the pane, **or** start a fresh ccmux session for the next sub-task | The "fresh session per sub-task" pattern is cheap because the worktree is cheap. |
| `/tokens` | Show context usage | `ccmux list` shows today's API cost via `ccusage`; per-pane token count stays in the REPL | Cost rolls up to the session, not the message — the granularity teams actually budget against. |
| `/web url` | Fetch a URL into chat | Claude Code's `WebFetch` tool, no slash needed | Direct tool calls beat slash commands; the model decides when to fetch. |
| `/voice` | Voice input | n/a in ccmux core; OS-level dictation works in any Zellij pane | Out of scope. |
| `/exit` | Quit | `Ctrl-d` in the pane, then `ccmux close <name>` to write the Obsidian handoff note | Closing the pane without `ccmux close` leaks the worktree; build the muscle memory early. |

Three commands carry over **unchanged** if you run Aider inside a ccmux
pane: `/add`, `/drop`, and `/diff` are pure REPL features. They keep
working because ccmux does not proxy the terminal — Zellij does, and
Aider talks to Zellij directly. The wrappers in the right column are
for the *cross-pane* case: querying or unwinding a session you are not
currently attached to.

## 3. The transitional pattern: Aider inside a ccmux pane

This is the recommended first week. You keep your Aider workflow
verbatim and gain ccmux's session, worktree, and handoff layers for
free.

Setup (assuming `pip install aider-chat` is already done):

```bash
ccmux init                                  # one-time, writes ~/.ccmux/config.json
ccmux new fix-auth-bug --llm aider          # worktree + Zellij tab + aider REPL
# ... work in Aider exactly as you always have: /add, /diff, /undo ...
ccmux close fix-auth-bug                    # writes Obsidian note with diffstat
```

What you gain immediately:

- **Parallel branches without `git worktree add` ceremony.** Spin up a
  second session for an unrelated bug; both Aider REPLs run side by
  side, neither sees the other's edits.
- **Cost visibility.** `ccmux list` aggregates token spend via
  `ccusage`; the Aider adapter (Task 230 §5.3) parses
  `.aider.llm.history` into the same column.
- **Handoff notes.** Each `ccmux close` posts a markdown summary to
  Obsidian with the baseline-to-HEAD diffstat and commit list. Tomorrow
  morning you can reconstruct what you did without re-reading the chat.

What does **not** change in Phase 1:

- Your slash commands (`/add`, `/drop`, `/diff`, `/undo`, `/run`,
  `/test`, `/architect`) all behave identically — they are Aider's
  feature, not ccmux's.
- Aider keeps auto-committing per turn. ccmux just records the baseline
  SHA at session start and reads the resulting commit range at close.
- Your `~/.aider.conf.yml` and `CONVENTIONS.md` are still honored;
  the adapter mounts `CLAUDE.md` as an additional `--read` file but
  does not overwrite Aider's own config.

## 4. When to move to Phase 2 (Claude Code as the REPL)

Phase 2 is not mandatory. Move when one of these starts to bite:

1. **You want SessionStart hooks** that run lint/typecheck/tests when a
   pane opens. Claude Code reads the hook config natively; running
   them around an Aider REPL is awkward.
2. **You want tool-use for non-edit work** — `WebFetch`, `Bash`,
   `WebSearch`, custom MCP servers. Aider's slash-command surface is
   smaller than Claude Code's tool registry by design.
3. **You want the daemon loop.** `ccmux auto <name>` runs Claude Code
   detached, pumping prompts from a queue. Aider's REPL is interactive
   by default and does not detach cleanly.

The migration itself is a one-flag change at session creation:
`--llm claude` instead of `--llm aider`. Worktree, handoff, and Obsidian
integration are identical. The cost is re-learning roughly six
commands, three of which (`/add`, `/drop`, `/clear`) you simply stop
using because Claude Code's context model is different (implicit
mentions, per-session scope, `Shift-Tab` for ask/edit toggle).

## 5. Anti-patterns to avoid

- **Do not `git worktree add` manually inside a ccmux session.** ccmux
  owns the worktree lifecycle; nested worktrees confuse `ccmux close`'s
  diff-capture path.
- **Do not run two Aider REPLs against the same worktree.** Use
  `--llm aider-architect` (Task 230 §5) which spawns one Aider with the
  architect/editor split — the supported way to get two models on one
  branch.
- **Do not skip `ccmux close`.** Killing the Zellij tab leaves the
  worktree and the session record on disk; `ccmux list` will keep
  showing the session as active. Always close cleanly so the Obsidian
  handoff note is written.

## 6. Quick reference card

```
Aider habit             ccmux idiom
-----------             -----------
new branch + aider      ccmux new NAME --llm aider
/add file               (in-pane /add still works) OR ccmux swap PROJECT
/diff (from elsewhere)  ccmux aider diff NAME
/undo (from elsewhere)  ccmux aider undo NAME
/run cmd                second Zellij pane (Ctrl-p n)
/exit                   Ctrl-d, then ccmux close NAME
parallel work           ccmux new SECOND-NAME ...
budget check            ccmux list           # ccusage-rolled cost
```

---

**Status**: complete. Companion to Task 230 (Aider adapter design);
together they cover both the *user* migration story and the *adapter*
implementation contract. No source changes in either task.
