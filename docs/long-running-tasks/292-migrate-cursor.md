# Migration from Cursor to ccmux

**Task**: 292/100 — Cursor → ccmux migration guide
**Date**: 2026-05-18
**Scope**: A practical mapping for a team or solo dev moving off Cursor
(cloud Background Agents + IDE) onto ccmux. Concept-to-concept table,
BugBot equivalent, and how to translate `.cursor/rules/` into
`CLAUDE.md` + ccmux's swap library. No source modifications.

This document complements `172-cursor-team-workflows.md` (which surveyed
how teams *use* Cursor in production). #172 answered "what is Cursor
good at"; #292 answers "if I'm leaving Cursor, what do I do on Monday
morning."

---

## 1. The shape of the move

You are most likely leaving Cursor for one of three reasons:

1. **Cost / lock-in** — Cursor's Pro/Business plan plus Background Agent
   minutes ends up north of Claude Code's flat cap for heavy users.
2. **Tooling sprawl** — your team standardised on Claude Code in the
   terminal and the IDE-bound Cursor seat is the odd one out.
3. **Control** — you want the agent to run in your own worktrees, on
   your own host, with your own n8n/cron triggers, not in Cursor's VM.

ccmux is built around exactly that last shape: Zellij tabs, git
worktrees, an `auto` loop, optional n8n webhooks, and Obsidian handoff
notes. The migration is not 1:1 — Cursor is an IDE, ccmux is a session
multiplexer — but every Cursor concept has a ccmux home.

---

## 2. Concept map

| Cursor concept | ccmux equivalent | Notes |
|---|---|---|
| In-editor Chat / Agent mode | `claude` inside a Zellij tab | `ccmux new <name>` opens one |
| Background Agent (cloud VM, opens PR) | `ccmux auto <name> --prompt "…"` (detached daemon) | Runs on your host, branch + worktree already wired |
| `/worktree` parallel experiments | `ccmux new` is *only* worktrees — N parallel sessions is the default | One tab per branch, no extra command |
| `/best-of-n` | `ccmux auto` N times with different model env / LLM backend per worktree | See `project.defaultLlm` in config |
| Automations (Slack/Linear/PagerDuty triggers) | `ccmux serve` HTTP endpoint + `n8n-workflows/` | `github-issue-to-ccmux.json` is the starter |
| Team Rules (dashboard, enforced) | `~/.ccmux/team-rules/` symlinked into per-project `CLAUDE.md` *(convention, not enforced)* | ccmux does not yet enforce precedence — see §6 |
| Project Rules (`.cursor/rules/*.mdc`) | `CLAUDE.md` + `.claude/commands/` in the project repo | `ccmux swap <project>` hot-loads these |
| User Rules | `~/.claude/CLAUDE.md` (untouched by swap when you scope properly) | |
| Custom slash commands (`.cursor/commands/`) | `.claude/commands/*.md` | Cursor explicitly imports these — same file format |
| Agent Skills (lazy-loaded) | Claude Code Skills (already a CC primitive) | Survives the move untouched |
| BugBot (pre-merge reviewer) | Reviewer pass via `ccmux auto --loop` with a reviewer prompt — see §4 | No GH Check yet; post via gh CLI |
| Autofix (BugBot patches its own findings) | Reviewer agent edits in same worktree, next `auto` iteration | |
| `@cursor remember [fact]` learned rules | `ccmux reflect <session>` then `--apply` to append to `CLAUDE.md` | Same loop, different mechanism |
| `cursor review` manual trigger | `ccmux auto review-<pr> --prompt @review.md` | One-shot reviewer |
| Cursor's MCP catalog | Claude Code MCP config (`~/.claude.json`) | Carries over unchanged |

The single biggest mental shift: in Cursor a "mission" is whatever the
Background Agent is currently doing; in ccmux a mission **is a named
session** — a worktree + a Zellij tab + (optionally) an `auto` loop with
a `TASK_STATE.md`. Name it after the ticket (`ccmux new T-1234`) and
the rest of the tooling — handoff notes, cost ledger, reflect output —
threads through that name.

---

## 3. Mapping Cursor agents onto ccmux missions

Cursor's surface area has three "agents" that need re-homing:

**Foreground Agent (IDE chat).** This becomes the default `ccmux new`
session. Open the tab, run `claude`, work interactively. Nothing
exotic. The Cursor "Composer" edit-tuned model has no direct analogue;
Claude Code's edit mode covers the same ground.

**Background Agent (cloud, long-running, opens a PR).** This is
`ccmux auto <name> --prompt "<goal>" --loop --until "<exit cond>"`. The
loop runs Claude headlessly under `--dangerously-skip-permissions`
inside a fresh worktree, writes `TASK_STATE.md`, and on `ccmux close`
emits an Obsidian handoff note. The "opens a PR" half is the one piece
you wire yourself: a post-loop hook that runs `gh pr create`. The
n8n-workflows directory is where that hook belongs if you want it
event-driven rather than command-driven.

**BugBot (PR reviewer).** Covered in §4 because it deserves its own
section.

For each Cursor automation you depend on (security review on push,
nightly coverage filler, PagerDuty → investigation), translate the
*trigger* to an n8n workflow that calls `ccmux serve`, and the *agent
body* to an `auto` invocation with a scoped prompt. The triggers
Cursor lists in its Automations post — schedule, Slack, Linear, GH PR
merge, PagerDuty, webhook — are all n8n-native, so the porting is
mechanical, not creative.

---

## 4. BugBot equivalent

There is no first-class BugBot in ccmux. The honest construction is a
*reviewer mission* run as a second `auto` session that watches the
first:

```
ccmux auto coder    --prompt @prompts/implement.md --loop --until "tests green"
ccmux auto reviewer --prompt @prompts/review.md   --loop --until "no findings"
```

Both share the same worktree (point `--prompt` at a file that pins the
branch) or the reviewer runs against the coder's diff via `git diff
main…HEAD`. Key properties to preserve from BugBot:

- **Different prompt, possibly different model.** Use the reviewer's
  worktree-local `settings.json` (swapped via `ccmux swap`) to pin a
  cheaper or stricter model.
- **Read prior review output to avoid duplicates.** Feed the previous
  iteration's reflection note in via `--resume <reviewer-session>`;
  ccmux already loads the last handoff for that name.
- **Publish a GitHub Check.** Post the reviewer's verdict with
  `gh pr comment` or `gh api repos/...check-runs` from the loop's
  exit hook.
- **Suppression escape hatch.** Adopt `// bugbot-ignore` literally —
  it's just a string the reviewer prompt is told to honour.
- **Learned rules.** When the reviewer flags the same issue twice,
  run `ccmux reflect reviewer --apply` to append the rule into
  `CLAUDE.md`. Same loop as Cursor's `@cursor remember`, different
  mechanism.

The field-reported 60/40 signal-to-noise ratio on BugBot will reproduce
here too. Tighten by scoping the reviewer prompt to a path glob
(`only files under src/api/**`) rather than asking for whole-repo
review.

---

## 5. Rules → CLAUDE.md

`.cursor/rules/*.mdc` files concatenate, in Cursor's documented order,
into one effective system prompt. The migration is a paste, but with
three rules of thumb that survive from #172:

1. **Sort by precedence, place important context last.** Team-level
   invariants (security, error handling) go at the bottom of
   `CLAUDE.md`, not the top. LLM recency bias is the same on
   Claude as on Cursor.
2. **Reference files, don't inline them.** A `CLAUDE.md` line of
   "logging conventions: see `docs/logging.md` and the example in
   `src/log/logger.ts`" outlives an inlined 200-line style guide.
3. **One rule per repeat mistake.** If `ccmux reflect` surfaces the
   same drift twice, that's a `CLAUDE.md` line.

Mechanically: concatenate `.cursor/rules/` into one `CLAUDE.md`,
gitignore a `CLAUDE.md.local` for personal overrides, register the
project in `~/.ccmux/config.json` with `claudeMd` pointing at the
canonical file, and `ccmux swap <project>` becomes your "switch teams"
button. For multi-repo teams, keep `team-rules.md` in a separate repo
and `cat` it onto each project's `CLAUDE.md` at swap time — that is
the closest ccmux gets today to Cursor's enforced Team Rules.

Custom slash commands transfer with zero edits: `.cursor/commands/foo.md`
becomes `.claude/commands/foo.md`. Cursor's "import Claude commands"
toggle exists precisely because the formats already align.

---

## 6. What you lose, and what to do about it

- **Enforced Team Rules.** ccmux has no admin layer; precedence is
  convention. Mitigation: a pre-commit hook (or CI step) that diffs
  `CLAUDE.md` against the team baseline and fails on drift.
- **GitHub Check from BugBot.** Wire it yourself via `gh api`.
- **Cloud VM isolation.** `auto` runs on your host. Use
  `--sandbox` (bubblewrap) for anything you would have let Cursor
  run remotely.
- **Mobile / web launch surface.** The n8n webhook + `ccmux serve`
  pair gets you 80% of the way there for "launch an agent from
  Slack on my phone."

Net: ccmux is the cheaper, more controllable substrate; Cursor is the
managed product. The migration is straightforward when you treat
**rules as code, missions as named sessions, and reviewers as just
another mission.**
