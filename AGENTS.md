# AGENTS.md — ccmux

Claude Code Multiplexer — Zellij × git worktree × Obsidian. Runs and hands off multiple Claude Code
sessions with automatic context transfer.

- **Stack**: TypeScript, Node `>=22.13`, Vitest, `tsc` build. Zellij-first (not tmux).
- **Setup**: deps auto-install via `.claude/bootstrap.sh` on SessionStart (local + web/cloud). Manual: `npm ci`.
- **Test**: `npm test` (→ `vitest run`). **Build**: `npm run build` (→ `tsc`).
- **Integrations**: Zellij (sessions), git worktree (isolation), n8n + Obsidian (context handoff) — these are runtime integrations, local-only.
- **Conventions**: see `CONTRIBUTING.md`; CI = vitest + tsc + CodeQL.

## Claude Code on the web

A cloud session auto-installs deps (SessionStart hook) and loads this `AGENTS.md` + `.claude/skills/`.
ccmux's own runtime (Zellij/n8n/Obsidian) is local — a cloud session is for reading/editing/testing
the code, not running the multiplexer. MCP is local-only. See `thinkyou0714/.github` →
`docs/claude-code-web-readiness.md`.
