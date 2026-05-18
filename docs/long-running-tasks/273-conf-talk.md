# Task 273 — Conference Talk Outline: ccmux

Status: complete
Duration: 45 minutes (35 min talk + 10 min Q&A)
Audience: Developers using AI coding agents; DevTool builders; engineering managers exploring parallel-agent workflows.

---

## 1. Title

**"Ten Claudes Walk Into a Worktree: Parallel AI Coding with ccmux"**

Backup titles (in case the conference wants something less whimsical):
- "ccmux: Orchestrating Parallel Claude Code Sessions with Zellij and git worktree"
- "From One Agent to Many: A Pragmatic Pattern for Concurrent AI Development"

---

## 2. Abstract (250 words)

Most teams adopting Claude Code, Cursor, or other AI coding agents hit the same wall after the first month: a single agent in a single repo is great for prototyping, but real engineering work is concurrent. You want one agent fixing a flaky test, another drafting a refactor, a third triaging a long-running migration — without them stomping on each other's branches, terminals, or context.

`ccmux` (Claude Code Multiplexer) is a small, opinionated tool that solves this by composing three primitives most developers already trust: **git worktrees** for filesystem isolation, **Zellij** for terminal multiplexing, and **Obsidian** for persistent cross-session handoff notes. The result is a workflow where `ccmux new fix-auth-bug` spins up a fresh worktree, a dedicated Zellij tab, and a Claude Code session — all wired together — in under two seconds.

This talk is part tool-demo, part design retrospective. We will walk through the core commands (`new`, `list`, `swap`, `auto`, `close`), watch ten Claude sessions run in parallel on a single laptop, and look at how `ccmux auto` enables true overnight autonomous work via detached daemons. Along the way we will discuss what we got wrong (early attempts at tmux integration, a bash RCE we shipped and patched), why Zellij-first was the right bet, and what we learned from instrumenting agent costs with ccusage.

Attendees will leave with: (1) a working mental model for parallel-agent development, (2) concrete patterns they can apply to any agent CLI, and (3) a candid view of the rough edges that come with putting LLMs in charge of your shell.

---

## 3. Slide Outline (35 minutes, ~30 slides)

### Act I — The Problem (8 min, slides 1–7)

1. **Title slide** — Title, name, handle, QR to repo.
2. **The "one agent" honeymoon** — Screenshot of a single Claude Code session. "This is great for a weekend."
3. **The wall** — Three real scenarios: (a) waiting 4 minutes for tests while wanting to start the next task, (b) wanting to A/B two refactor approaches, (c) wanting an overnight migration agent.
4. **Why not just `git checkout`?** — Branch switching nukes node_modules, breaks dev servers, loses terminal scrollback.
5. **Why not tmux + scripts?** — Most folks already have a half-built version of this. Show audience poll: "raise your hand if you have a `~/bin/new-branch.sh`".
6. **The three primitives we need** — Filesystem isolation, terminal isolation, context isolation.
7. **Enter ccmux** — One-line pitch + architecture diagram.

### Act II — The Tool (12 min, slides 8–18)

8. **Architecture diagram** — `ccmux` CLI (Node/TS) → git worktree + Zellij IPC + Obsidian REST + optional n8n webhooks.
9. **Why Zellij and not tmux** — Native layouts, JSON-friendly IPC, graceful degradation, plugin model. Quick comparison table.
10. **`ccmux new <name>`** — Live command walkthrough; show the resulting worktree under `.claude/worktrees/`.
11. **`ccmux list`** — Active sessions + today's API cost via ccusage. Real numbers from a recent week.
12. **`ccmux swap <project>`** — Hot-swap `CLAUDE.md` and `settings.json` between projects without restarting the agent.
13. **`ccmux auto`** — Detached daemon mode. The "overnight agent" pattern.
14. **`ccmux close`** — The handoff-note step. Why writing to Obsidian beats writing to a stale `NOTES.md`.
15. **Config surface** — `~/.ccmux/config.json` walkthrough; what we deliberately left out.
16. **Integrations** — n8n workflows for cost alerts, Obsidian for the knowledge graph, optional litellm for routing.
17. **What it is not** — Not a Claude Code replacement, not a CI system, not a sandbox.
18. **Code map** — `src/commands`, `src/core`, `src/integrations`. ~3k LOC total; deliberately small.

### Act III — Live Demo (8 min, slides 19–22, mostly terminal)

19. **Demo intro slide** — "Three real tasks, ten minutes, one laptop." (See Section 4.)
20. **Demo recap slide** — Screenshot of finished state.
21. **What you didn't see** — The two times I had to `ccmux close --force`.
22. **Cost slide** — ccusage output: $X for the demo, broken down by session.

### Act IV — Lessons and Rough Edges (5 min, slides 23–27)

23. **The bash RCE we shipped** — Task 22 retrospective. Lesson: never `exec` a user-supplied session name.
24. **Worktree leak detection** — Why we added `ccmux gc`.
25. **Context handoff is the hard part** — Notes vs. memory vs. CLAUDE.md. Why we picked Obsidian.
26. **Cost discipline** — Parallel agents 10x your spend overnight. Guardrails matter.
27. **What we would do differently** — Probably start with worktree-only and add multiplexer later.

### Act V — Wrap and Q&A (2 min, slides 28–30)

28. **Patterns you can steal** — Even without ccmux: worktree-per-task, handoff notes, daemon mode.
29. **Roadmap** — Aider adapter (task 230), Cursor team workflows (task 172), industry survey (task 180).
30. **Thank you / repo QR / Q&A**

---

## 4. Demo Plan (8 minutes, hard-timed)

**Setup before talk starts:**
- Pre-warmed `~/.ccmux/config.json` pointing at a sample repo with intentional bugs.
- ccusage cleared for the day so the cost number is clean.
- Zellij session already running with one empty tab.
- Network mocked for known-flaky API call.

**Live sequence (with timer):**

| t (min) | Action | Slide / Terminal | Talking point |
|---------|--------|------------------|---------------|
| 0:00 | `ccmux new fix-flaky-test` | Terminal | "One command. Worktree, tab, agent." |
| 0:30 | Paste failing test output, ask Claude to fix | Terminal | Audience watches the agent think |
| 1:30 | `ccmux new draft-refactor` in second tab | Terminal | "Same repo, isolated branch." |
| 2:00 | Ask second agent for a refactor sketch | Terminal | Show that the first agent is unaffected |
| 3:00 | `ccmux auto overnight-migration` | Terminal | Daemon spawns; show `ps` |
| 3:30 | `ccmux list` | Terminal | Three sessions, live cost ticker |
| 4:30 | Switch back to first tab — test now green | Terminal | Commit, `ccmux close fix-flaky-test` |
| 5:30 | Show Obsidian handoff note that was just written | Browser | "This is what 'context' looks like." |
| 6:30 | `ccmux swap other-project` | Terminal | CLAUDE.md hot-swap demo |
| 7:30 | Final `ccmux list` + cost reveal | Terminal | "Total spend: $X." |

**Fallback plan if live demo breaks:**
- Pre-recorded 90s asciinema of the same sequence loaded on slide 19b.
- Screenshots of each step ready as slides 19c–19j.

---

## 5. Q&A Bank (15 anticipated questions)

1. **"How is this different from `git worktree add` + a shell alias?"**
   It is exactly that, plus terminal lifecycle, cost tracking, handoff notes, and a daemon mode. The value is the composition, not any single piece.

2. **"Why not Cursor's multi-agent features?"**
   Cursor is editor-bound; ccmux assumes a terminal-first workflow. Task 172 explores this tradeoff in depth.

3. **"Does this work on macOS?"**
   Yes, anywhere Zellij + Node 22 run. Primary development is WSL2 / Linux; macOS is tested but less polished.

4. **"What about Windows without WSL?"**
   Not supported. Zellij and git worktrees both have rough edges on native Windows.

5. **"How do you stop ten agents from racking up a $500 bill?"**
   `ccmux list` shows live cost. We have an n8n workflow that pages on a configurable threshold. Daemon sessions also accept a `--max-cost` flag.

6. **"What happens when two agents touch the same file?"**
   They cannot — each lives in its own worktree. Merge conflicts surface at PR time, same as any other parallel branch.

7. **"Can I use this with Aider / Codex / OpenCode?"**
   Adapter for Aider is in flight (task 230). The session abstraction is intentionally agent-agnostic.

8. **"How do you handle secrets across worktrees?"**
   `.env` lives in the worktree root (not committed). Settings hot-swap explicitly does not touch env files.

9. **"What is the bash RCE story?"**
   Early versions shell-quoted session names incorrectly. Patched in task 22; we now treat session names as opaque identifiers and validate against a strict allowlist.

10. **"Why Obsidian instead of a database?"**
    Because the user already has it open. Handoff notes are read by humans more often than by agents.

11. **"Does `ccmux auto` keep running after I close my laptop?"**
    Yes, it is a detached daemon. We use `setsid` and write logs under `~/.ccmux/logs/`.

12. **"How do you handle the agent going off the rails autonomously?"**
    Daemon mode caps tool calls per hour and writes to a journal. You can `ccmux tail <name>` to watch live, and `ccmux kill` to stop.

13. **"What is the licensing model?"**
    MIT. See `LICENSE`.

14. **"How big is the team?"**
    Originally one person plus a lot of Claude. Currently a small group of contributors.

15. **"What would you build next if you had three months?"**
    A first-class adapter layer so the same orchestration works across Claude Code, Aider, and Cursor CLI — basically generalizing the lessons from task 180's industry survey.

---

## 6. Speaker Notes

- Open with the audience poll on slide 5; it sets the "you already started building this yourself" tone.
- The demo is the heart of the talk; protect those 8 minutes ruthlessly.
- Avoid framing ccmux as "the answer." It is one shape of an answer; the patterns matter more than the binary.
- Keep cost numbers real — the audience will notice if they look staged.
- Leave 10 full minutes for Q&A; this topic generates strong opinions.
