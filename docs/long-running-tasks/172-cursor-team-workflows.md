# Cursor Team Workflows — Production Patterns and Lessons for ccmux

**Task**: 172/100 — Cursor team workflows study
**Date**: 2026-05-18
**Author**: ccmux long-running task #172
**Scope**: Survey how engineering teams use Cursor in production (team rules,
shared prompts, BugBot, background/cloud agents, automations) and extract
concrete lessons for ccmux. No source modifications.

---

## 1. Why study Cursor here

ccmux already does the "many parallel CC sessions" piece (Zellij tabs + git
worktrees + `auto` loop daemon). The open questions are upstream of that:
how do *teams* — not solo power users — actually govern AI coding agents so
the output stays consistent, reviewable, and safe to merge? Cursor has
spent the last year shipping infrastructure aimed exactly at that problem
(Team Rules, BugBot, Background Agent, Cursor 3 worktrees, Automations).
The patterns generalise; the pain points predict ours.

Sources surveyed: Cursor's own docs and changelog (Bugbot, Background
Agent, Automations, "Best practices for coding with agents"), and field
write-ups from Atlan, Rippling, Markaicode, Developer Toolkit, Stork.AI,
and a handful of practitioner blogs (Naveen Yarlagadda, Olivia Craft,
youngju.dev).

---

## 2. The team-rules layer — what teams actually do

The single most repeated lesson across every source: **check `.cursor/rules/`
(or `.cursorrules`) into git**. Without that, every developer gets a
different AI, code review becomes "fix the AI's drift", and PR cycles
inflate. Olivia Craft's team reports a 60% drop in PR revision cycles and
6 hours/week saved across 4 devs after moving from "fancy autocomplete"
usage to scoped, committed rules.

**Rule taxonomy that recurs (Atlan blog is the cleanest):**

1. **Project Rules** — what the repo is and how it's structured (always-on).
2. **Tech Stack Rules** — how the team writes code (always or agent-requested).
3. **Micro-workflow Rules** — how the team *behaves* (logging, feature
   flags, telemetry shape, PR readiness).
4. **Meta Rules** — how the AI should prioritise/interpret the other rules.

**Precedence (Cursor's documented order):**
Team Rules (dashboard, Team/Enterprise plans) → Project Rules
(`.cursor/rules/`) → User Rules. Enforced Team Rules cannot be overridden
by individuals — this is the "security/error-handling must hold" knob.

**Practical findings from the field:**

- **Be assertive and specific.** "Use arrow functions" fails; "ALL
  functions must use arrow syntax: `const fn = () => {}`" sticks
  (Markaicode).
- **Reference files, don't copy them.** Cursor's own best-practice post
  says rules should point at canonical examples in the codebase, not
  inline 200 lines of style guide — otherwise rules go stale silently.
- **Place important context last.** Atlan reports this materially changes
  adherence (LLM recency bias).
- **Use `@include` for reusable snippets** to keep rules DRY.
- **Audit `alwaysApply: true`.** 30+ always-on rules bloat the context
  window and *slow* the agent.
- **Personal overrides are gitignored**, not deleted: `.cursorrules.local`
  is the common convention.
- **Update rules when the agent makes the same mistake twice.** Cursor
  even supports `@cursor` on a GitHub issue to have the agent update the
  rule for you.

---

## 3. Shared prompts — commands and skills

Cursor splits this two ways:

- **Custom slash commands** in `.cursor/commands/` (markdown files,
  checked into git). Triggered with `/name` in chat. Used for repeatable
  workflows: `/fix-issue`, `/package-health-check`, `/init` (Rob Shocks'
  pattern: a repo-scanning command that emits a project brief for every
  new chat).
- **Agent Skills** — dynamic, loaded *only when relevant*. Unlike rules,
  skills don't eat context budget unless invoked. Skills can include
  hooks (scripts before/after agent actions) and domain knowledge.

Cursor explicitly supports importing Claude Code commands ("import Claude
commands" toggle in Rules & Commands settings) so teams that straddle
both tools keep one library. This is a hint about portability that ccmux
should heed: prompt assets are becoming a *cross-tool* artifact.

Naveen Yarlagadda's "Ticket-to-PR" pipeline shows the upper bound of this
layering: `.cursorrules` (always) + MCP servers (Azure DevOps, Jira,
GitHub, Datadog) + Composer (Cursor's edit-tuned model) + Shadow
Workspace (sandboxed test runs) — read ticket → plan → execute → verify
→ open PR, all without leaving the editor.

---

## 4. BugBot — pre-merge AI review as a separate role

BugBot is interesting because Cursor deliberately built it as a
*different* agent from the IDE coder. Key shape:

- Runs automatically on every PR open/update; manual trigger via
  `cursor review` or `bugbot run` comment.
- Reads existing PR comments to avoid duplicate suggestions and build on
  prior feedback.
- Publishes a `Cursor Bugbot` GitHub check.
- **Layered rules**: Team Rules → repository rules (learned or manual) →
  project `BUGBOT.md` (including nested files) → User Rules. BugBot
  merges all of them.
- **Learned rules**: opt-in. BugBot generates rules from team PR activity
  history. Inline teaching via `@cursor remember [fact]` on any PR.
- **Autofix**: spawns a Cloud Agent in a VM to actually patch the issues;
  >35% of Autofix changes are merged into the base PR (Cursor's stat).
- Suppression escape hatch: `// @bugbot-ignore` comments.

The honest field report (Toolstac) puts BugBot at "real issue ~60%,
false positive ~40%" without tuning. The fix is narrower rules — "async
functions in `src/api/` wrap their body in try/catch" beats "all
functions must have error handling."

**The composite review pipeline that real teams converge on:**

1. Author runs Agent Review locally on the diff before pushing.
2. BugBot reviews the PR when opened.
3. Human reviewer focuses on architecture, business logic, design — the
   things the AI is *least* equipped to judge.
4. Author addresses both AI and human feedback, often by asking Agent
   mode to implement the AI's own suggested fix.

---

## 5. Background / Cloud Agents and automations

Background Agent (GA in Cursor 1.0, June 2025) runs in a remote sandbox,
clones the repo, branches, and opens a PR — usable from the editor, the
web, or mobile. Cursor 3 (April 2026) extended this with `/worktree` and
`/best-of-n` for parallel local experiments, and automations that
trigger on schedule, Slack, Linear, GitHub PR merge, PagerDuty, or
custom webhooks.

The youngju.dev practitioner heuristic for *where each tool belongs*:

- **Background Agent**: long-running, repetitive, safe to draft remotely,
  easier to review after the fact than interactively.
- **`/worktree`**: isolated experiments and risky changes.
- **`/best-of-n`**: same task, multiple models, pick the best.
- **Direct in-editor**: small edits, anything needing immediate human
  judgement.

Cursor's own production automations (from their Automations post) are
worth listing because they are *exactly* the categories ccmux's `auto`
loop is adjacent to:

- Security review on every push to `main`, posting high-risk findings to
  Slack (non-blocking, longer-running).
- PR risk classification → auto-approve low-risk, assign reviewers for
  high-risk, log to Notion via MCP.
- PagerDuty incident → Datadog MCP investigation → Slack message with
  proposed-fix PR.
- Weekly merged-PR digest to Slack.
- Nightly test-coverage gap-filler agent.
- Slack bug report → Linear MCP issue → investigate root cause → reply
  in thread.

Rippling's Abhishek Singh wired a cron agent every two hours that
deduplicates across Slack, GitHub PRs, and Jira and posts a dashboard.

---

## 6. Lessons for ccmux

Mapping the above onto where ccmux is today:

1. **Treat shared rules/prompts as a first-class artifact, not config.**
   ccmux's `swap` already moves `CLAUDE.md` + `settings.json` between
   projects. The Cursor lesson is to also formalise a `commands/` and
   `rules/` directory layout in each project and make `ccmux swap` (or a
   new `ccmux sync-rules`) responsible for keeping it consistent. Hot-
   swap the *prompt library*, not just CLAUDE.md.

2. **Make rule precedence explicit.** Cursor's Team → Project → User
   ordering is the right model. A ccmux session today inherits CLAUDE.md
   purely by file path; adding an enforced "team rules" layer (e.g.
   `~/.ccmux/team-rules/`) that always merges in would prevent per-
   worktree drift across the parallel agents `auto` spawns.

3. **A BugBot-shaped role belongs in the `auto` loop.** Right now the
   loop runs the same Claude with the same prompt until `--until` fires.
   The Cursor pattern says: *separate the coder and the reviewer*.
   A second agent (different prompt, possibly different model) that
   reviews each iteration's diff before the loop continues would catch
   exactly the drift class that long-running CC sessions are notorious
   for. The fact that BugBot reads prior PR comments to avoid repeating
   itself is directly relevant — ccmux should feed the reviewer the
   previous review's output.

4. **`/best-of-n` is a real pattern, not a gimmick.** ccmux already has
   git worktrees and Zellij tabs — running the same task across three
   models in three worktrees and diffing the results is one config away.
   This is the highest-leverage parallelism story for ccmux specifically
   and worth promoting from "you could do this" to "`ccmux race <task>`".

5. **Automations > manual loops.** Cursor's move from "click to launch
   an agent" to "agent triggered by event" is the durable direction.
   ccmux's `auto` loop is currently time/iteration-bounded. Event
   triggers (filesystem change, n8n webhook, PagerDuty, Obsidian note
   created) would close the gap. The n8n-workflows directory is already
   there — wire it in.

6. **Onboarding is a rules problem, not a docs problem.** Every team
   write-up converges on "the `.cursorrules` file became our most-read
   document". ccmux's `swap` + a curated rules library means a new dev's
   first `ccmux new` gives them the same AI quality as a veteran — same
   pitch, different substrate.

7. **Audit-and-prune is part of the workflow.** Olivia Craft's 2-minute
   per-PR audit ("does the diff match rules? any new patterns to
   encode? any unapproved deps?") is exactly the kind of thing ccmux
   could surface in the Obsidian handoff note on `ccmux close`.

---

## 7. Open questions / follow-ups

- Should ccmux ship a default `rules/` scaffold, or stay rules-agnostic
  and just provide the plumbing?
- Reviewer-agent prompt: separate model, separate Anthropic key, or just
  separate system prompt? Cost vs quality trade-off needs measuring.
- How does the "learned rules" idea (BugBot's `@cursor remember`) map
  onto Claude Code's `/memory` and the existing Obsidian handoff stream?
  Possibly the handoff *is* the learned-rules store already.

---

## 8. References

- Cursor — Best practices for coding with agents (cursor.com/blog/agent-best-practices)
- Cursor — Bugbot docs (cursor.com/docs/bugbot)
- Cursor — Bugbot Autofix (cursor.com/blog/bugbot-autofix)
- Cursor — Automations (cursor.com/blog/automations)
- Cursor 1.0 changelog (cursor.com/changelog/1-0)
- Atlan engineering — Cursor Rules in Action (blog.atlan.com/engineering/cursor-rules/)
- Developer Toolkit — Team Collaboration and AI-Enhanced Code Reviews
- Naveen Yarlagadda — Scaling Engineering Velocity with Cursor (Medium)
- Olivia Craft — The Cursor AI Workflow That Saves My Team 6 Hours a Week (dev.to)
- Markaicode — Manage Cursor AI Rules for Team Consistency
- youngju.dev — Cursor Practical Guide (Background Agent, Memories, Bugbot, Worktrees)
- Toolstac — Cursor Background Agents & Bugbot troubleshooting
- Stork.AI — Cursor AI Tutorial: The Ultimate Workflow
