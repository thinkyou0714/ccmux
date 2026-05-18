# Task 180 — Industry Survey: How Teams Actually Use AI CLIs

Date: 2026-05-18
Scope: Synthesize public reports, vendor surveys, practitioner blog posts, and conference talks from late 2025 through mid-2026 to characterize how engineering teams use AI coding CLIs (Claude Code, Codex, Gemini CLI, Aider, Cursor agents, Junie). Distill pain points and translate them into positioning guidance for **ccmux**.

Sources surveyed (representative, not exhaustive):

- JetBrains AI Pulse & Developer Ecosystem Surveys (Sep 2025, Jan 2026 waves)
- State of Code 2025 (stateofcode.ai / Devographics)
- Sonar 2026 State of Code Developer Survey (1,100+ pro devs)
- Stack Overflow 2025 Developer Survey — AI section
- Digital Applied AI Coding Tool Adoption Survey, Q1 2026 (2,847 devs across 320 teams)
- Stacklok 2025 State of AI Codegen (300+ engineering leaders, 100+ employee orgs)
- The Modern Software Developer "State of AI Coding 2025"
- Practitioner blogs: Addy Osmani (O'Reilly CodeCon 2026), Tamir Dresher talk, Ashu's parallel-agent post, Will Ness, Javier Aguilar, Dariusz Parys, Fazm series, Siddhant Khare (agent observability)
- Enterprise rollout playbooks: systemprompt.io, Big Hat Group, Adversis, claudelab, maisumhashim

---

## 1. The macro picture: AI CLIs have crossed the chasm

The most consistent finding across every 2025–2026 survey is that AI coding tools are no longer a curiosity; they are baseline infrastructure for working developers.

- **Daily use is the norm.** Stack Overflow 2025 puts daily AI tool usage by pros at 51%. Sonar reports 72% of developers who have tried AI tools now use them daily. State of Code 2025 puts daily use at 87% with only 2% having tried-and-quit. The Modern Software Developer survey shows 98% using AI tools several times per week.
- **AI authors a material share of committed code.** Sonar's headline number: 42% of committed code today is AI-generated or AI-assisted, projected to reach 65% by 2027.
- **Claude Code is the breakout CLI.** JetBrains (Jan 2026) reports Claude Code at 18% adoption-at-work globally (24% in US/Canada), up 6× from April–June 2025. CSAT 91%, NPS +54 — the highest loyalty in the category. State of Code 2025 has Claude Code as the most-used tool overall (57%) and #1 recommendation (43%). Digital Applied's Q1 2026 survey has Claude Code at 28% primary-tool share, ahead of Cursor (24%) and Copilot (17%).
- **Most teams run a stack, not a single tool.** Digital Applied finds the average dev uses 2.4 tools; Big Hat Group's enterprise guide explicitly advocates a Gemini CLI (free, exploration) + Claude Code (architecture, complex execution) + Codex CLI (CI/CD, GitHub) split.
- **Workflows are bifurcating.** Stack Overflow 2025: 14% use AI agents daily, but 38% explicitly have no plans to adopt them. The market is splitting into copilot users and orchestrator users — and the orchestrator camp is where CLIs dominate.

The strategic takeaway is that the CLI form factor has won as the surface for "agentic" use cases (multi-file edits, async background work, parallel sessions), while IDE-embedded tools still dominate inline autocomplete. ccmux lives on the agentic side of this split.

## 2. How teams actually use CLI agents

Synthesizing across surveys and practitioner write-ups, a stable taxonomy emerges:

1. **Solo with one CLI session.** Still the modal usage. Claude Code or Codex open in a single terminal, conversational, sometimes in a tmux pane next to a dev server. ~60–70% of CLI users.
2. **One CLI plus one IDE assistant.** Cursor or Copilot for autocomplete; Claude Code/Codex CLI for multi-file refactors and "go figure this out" tasks. Roughly the median pro setup in 2026.
3. **Parallel sessions, same machine.** 2–5 simultaneous CLI agents in tmux, Zellij, iTerm tabs, or VS Code terminals. Every parallel-agent blog post (Ashu, Will Ness, Fazm, Aguilar, Parys) converges on **git worktrees + tmux/Zellij + per-worktree env** as the canonical pattern. Practical ceiling is 3–5 before review/merge overhead dominates.
4. **Orchestrated agent teams.** A lead agent spawning specialized teammates (Claude Code Agent Teams behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, OpenClaw + Antfarm, Conductor, Claude Squad, Vibe Kanban). Addy Osmani's CodeCon 2026 talk frames this as the shift from "conductor model" to "orchestrator model."
5. **Cloud / background agents.** Codex async tasks, Claude Code headless mode, Jules, Cursor Background Agents, Antigravity, JetBrains Air. The human is no longer at the terminal; they assign tasks and review PRs.

The JetBrains 2026 wave makes the directional point that purpose-built orchestration surfaces (Air, Central, Junie CLI, Antigravity) are the area of fastest vendor investment. The "AI CLI" is converging with the "agent runtime."

## 3. What people actually use CLIs for

State of Code 2025 + Sonar + Stack Overflow agree on the use-case ranking:

- New code / feature scaffolding (~90% use, ~55% rate it highly effective)
- Refactoring (~72% use, ~43% effective)
- Writing tests (~71% use, ~59% effective)
- Debugging (~68% use)
- Explaining unfamiliar code (~76% use, ~66% effective — one of the highest "actually works" ratings)
- Documentation (~49–74% effective depending on source)
- Boilerplate, env setup, migrations, PR reviews — the tasks devs most want to fully delegate

The **gap between use and effectiveness** is the real story. Devs throw AI at everything but rate it highly effective on a narrower slice (explainers, docs, tests). Brownfield > greenfield: Stacklok reports 68% of engineering leaders believe AI is better applied to existing code than new code, and 75% would rather AI handle operational tasks than creative ones — the opposite of how vendors market the tools.

Reasons devs cite for using AI CLIs (State of Code 2025):

- Code faster (75%)
- Reduce repetitive tasks (56%)
- Prototype ideas (56%)
- Understand existing code (47%)
- Generate tests/docs (44%)

## 4. Pain points — the consistent ones

Aggregating "what frustrates you" responses across surveys and blogs:

### 4.1 Quality and trust
- **Hallucinations** are the #1 cited problem across every survey. State of Code: 58% report inaccurate/hallucinated code as the biggest challenge; 49% want fewer hallucinations as the top requested improvement. Sonar: 96% do not fully trust AI-generated code; only 48% always verify before committing.
- **Review bottleneck.** Digital Applied finds reviewing AI code is now the largest weekly time sink at 11.4 hrs/week, up 31% YoY, having overtaken writing. Sonar: 38% say reviewing AI code is harder than reviewing human code. Aguilar's talk and Osmani's CodeCon talk both name this as the central scaling problem: at 4–5 parallel agents the human becomes the merge bottleneck.

### 4.2 Cost and rate limits
- 43% of State of Code respondents want more affordable pricing. Parys's tmux multi-agent write-up explicitly calls out weekly limits being hit hard when running teams on Max plans. Ashu's parallel-agent post: he was "stuck at 16%" on $200/month until he restructured for parallelism, then "hit weekly rate limits."
- Fazm's "ctrl+c muscle memory" post frames this viscerally: every wasted agent minute is real money, so killing off-track agents fast is a learned skill.

### 4.3 Context and memory
- 41% want better understanding of large codebases; "better memory of past sessions" is in the top requested improvements.
- The Modern Software Developer survey finds the most-requested improvement category is "agents adapting to developer and codebase practices."
- This is why `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` have become standard — the State of AI Coding survey notes the majority of devs now adopt some agent-specific configuration file.

### 4.4 Parallelism: file conflicts, env collisions, coordination
Practitioner blogs converge on a remarkably uniform list of pain points when running multiple CLI sessions:

- **File collisions** — two agents editing the same file is the headline failure mode. Solved by git worktrees, near-universally.
- **Port collisions** — two dev servers on :3000. Solved by per-worktree port allocation.
- **`node_modules` / build state corruption** — shared dependencies break.
- **Migration / DB conflicts** — only one session can own migrations.
- **`CLAUDE.md` drift** — each worktree gets a copy; updates don't propagate.
- **Naming chaos** — "agent-3" tells you nothing; tab/window labels become essential.
- **Mental load** — 5 agents is the practical ceiling before the human can't track what each is doing. Multiple sources (Fazm, the "Managing 5+ Parallel" post, Ashu) converge on 3 well-coordinated > 5 poorly-coordinated.

### 4.5 Observability and audit
Khare's "agent observability gap" article is the sharpest articulation: agents are distributed systems, but we have terminal scrollback instead of traces. There is no standard way to answer "what files did this agent touch this session?" without parsing raw output. Background and headless execution makes this acute. Compliance frameworks (EU AI Act, SOC 2) will force this.

### 4.6 Governance, security, shadow AI
Stacklok's 300-leader survey: tools are heavily used unofficially. Copilot is officially supported in 78% of orgs that use it, but Claude Code only in 39%, Windsurf 34%, Cursor 31%. **Shadow AI is the default state**, and 59% of engineering leaders name security/compliance posture as the #1 factor in tool choice — well ahead of features.

Enterprise rollout playbooks (systemprompt, Big Hat, Adversis, claudelab) all hammer the same controls:
- Managed `settings.json` deployed via MDM (Jamf/Intune), with `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `disableBypassPermissionsMode`, `forceLoginOrgUUID`.
- Hook-based audit trails (PreToolUse/PostToolUse → audit endpoint).
- MCP allowlists; shadow MCP servers are the new shadow IT.
- Devcontainer / sandbox isolation; default-deny network egress.
- Project-scoped hooks treated as untrusted (clone-an-internal-repo-and-pwn-yourself attack surface).

### 4.7 Onboarding and team enablement
Stacklok: "lack of trust in outputs" and "legal/compliance concerns" are the top adoption impediments. Systemprompt's playbook calls out under-training as the #2 reason rollouts fail. Junior vs senior split appears repeatedly: juniors over-adopt, seniors are skeptical (Sonar, Modern Software Developer).

## 5. Where the puck is going

Triangulating vendor roadmaps + JetBrains + Osmani:

- **Orchestration is the next category.** JetBrains Central, Air, Antigravity, Conductor, Vibe Kanban, OpenClaw + Antfarm, Claude Squad, ccswarm/Citadel. Three tiers are emerging (Osmani): local single-agent → local multi-agent on your machine → cloud-hosted background fleets.
- **Worktrees are now table-stakes.** Anthropic shipped built-in worktree support in early 2026, validating the practitioner pattern. Gemini CLI lists worktrees as an experimental feature.
- **Observability stacks for agents are nascent.** Sentry, Grafana+Prometheus dominate (per Stack Overflow 2025), with `agent-trace`, `LLMTraceFX`, OpenTelemetry for LLMs as emerging primitives.
- **Async / background dominates new product launches.** Claude Code Web, Jules, Codex async, Cursor Background Agents.

## 6. Lessons for ccmux positioning

ccmux is a Zellij-first multiplexer with git worktree creation, CLAUDE.md/settings hot-swap, ccusage cost surfacing, and n8n + Obsidian handoff integration. Mapping that against the survey findings:

### 6.1 What ccmux already gets right
- **Worktree-per-session is the consensus pattern.** Every parallel-agent blog post lands on it. ccmux making this the default `ccmux new` flow is directly aligned.
- **Cost surfacing via `ccmux list` + ccusage** answers a real top-3 pain (cost/rate-limits). Most orchestration tools surveyed don't show $$ in the session list.
- **Obsidian handoff on `close`** maps onto the observability gap — practitioners explicitly note that "agent finished, can't summarize what it did" is a daily problem.
- **Zellij-first, not tmux-only.** A small but real differentiator. Tmux is the assumed substrate in every blog post; serving the Zellij minority is a non-zero wedge.
- **`swap` for CLAUDE.md / settings** addresses the CLAUDE.md-drift pain that appears repeatedly.

### 6.2 Sharpest positioning angles given the data

1. **"Orchestrator-mode for the 3–5 agent sweet spot."** Don't compete with cloud-hosted fleets (Jules, Codex async, Antigravity). Don't compete with the IDE assistants. Target the local-multi-agent tier (Osmani's middle tier) where the empirical ROI is highest and tooling is fragmented. The 3-to-5 ceiling shows up in 4+ independent sources — that is ccmux's natural sweet spot.
2. **"Bring your own session manager — we just wire it up."** Zellij vs tmux is a religious war. Lean into degrading-gracefully (already in README) and treat the multiplexer as substitutable. The differentiator is the *session lifecycle* (worktree → CLAUDE.md → handoff), not the pane manager.
3. **Lean into the review-bottleneck problem.** Digital Applied's data: review is now the #1 time sink. ccmux already has Obsidian handoff; consider surfacing per-session diff summaries, `git log --since=session-start`, and "what changed" notes in the close flow. That is the actual unmet need above "spawn another agent."
4. **Cost-aware scheduling.** Weekly limits are the binding constraint for paid CC users. `ccmux list` showing today's cost is good; showing "you're at 62% of weekly limit, consider downgrading the next auto-session to Sonnet" would be sharper. Aligns with Parys's observation that mixed-model agent teams stretch budgets.
5. **Be honest about the audit/governance gap.** ccmux is a personal-productivity tool, not an enterprise-governed harness. Don't try to play in the managed-settings/MDM space — Anthropic owns that with `managed-settings.json`. Instead, position ccmux as the *individual-developer* counterpart that complements managed enterprise deployments rather than competing with them.
6. **n8n integration is a hidden moat.** Stacklok shows 75% of leaders want AI on operational tasks. Most agent harnesses don't speak to workflow engines. A "ccmux session triggered by n8n webhook" story is differentiated and matches what teams actually want from agents (ops automation, not greenfield code).

### 6.3 Pitfalls to avoid

- **Don't reinvent Agent Teams.** Anthropic's own multi-agent feature, OpenClaw, Conductor, and Antfarm are all racing to own intra-agent orchestration. ccmux should *host* those, not compete.
- **Don't oversell parallelism.** Every honest practitioner says 3 well-coordinated agents > 5 chaotic ones. The marketing temptation is "run 10 agents!"; the truthful message is "run the right 3."
- **Don't ignore hooks.** Hooks (PreToolUse / PostToolUse / Stop / SessionStart) are how every enterprise playbook implements audit. ccmux's session-start/close flow should integrate with hooks, not replace them.
- **Don't depend on a single CLI.** Junie CLI, Gemini CLI, Codex, and Aider are all live. A session-manager that only knows Claude Code ages badly. The README already implies CC-only; future-proofing the abstraction is cheap insurance.

## 7. One-paragraph TL;DR

The AI-CLI market in 2026 is dominated by Claude Code, structured around the agentic CLI form-factor, and rapidly evolving toward orchestrated multi-agent workflows on git worktrees. Every survey points to three durable pain points: trust/review overhead, cost/rate-limits, and the absence of session-level observability. The strongest practitioner consensus is "3–5 parallel worktree-isolated agents in tmux/Zellij with shared CLAUDE.md and disciplined task scoping." ccmux's existing primitives (worktree-per-session, cost surfacing, CLAUDE.md hot-swap, Obsidian handoff) map directly to this consensus. The clearest positioning is **"local orchestrator for the 3–5 agent sweet spot, with first-class cost and handoff awareness, multiplexer-agnostic, CLI-agnostic"** — staying narrowly out of the way of Anthropic's enterprise managed-settings path and cloud-fleet products like Jules/Antigravity.

---

End status: complete.
