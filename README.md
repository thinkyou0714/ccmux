# ccmux — Claude Code Multiplexer

[![CodeQL](https://github.com/thinkyou0714/ccmux/actions/workflows/codeql.yml/badge.svg)](https://github.com/thinkyou0714/ccmux/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Star History Chart](https://api.star-history.com/svg?repos=thinkyou0714/ccmux&type=Date)](https://star-history.com/#thinkyou0714/ccmux&Date)

Zellij × git worktree × Obsidian integration for managing parallel Claude Code sessions.

## Features

- `ccmux new <name>` — Create a session: git worktree + Zellij tab + Claude Code
- `ccmux list` — Show active sessions + today's API cost (via ccusage)
- `ccmux close <name>` — Close session + write Obsidian handoff note
- `ccmux swap <project>` — Hot-swap `CLAUDE.md` + `settings.json` to another project
- `ccmux auto [name]` — Launch autonomous CC session (detached daemon or Zellij tab)
- `ccmux serve` — Run the ccmux HTTP control server
- `ccmux merge <name>` — Merge a session's worktree branch back
- `ccmux logs [name]` — Tail session logs
- `ccmux prune` — Remove stale worktrees + dead sessions
- `ccmux reflect <name>` — Generate a reflection/handoff note for a session
- `ccmux dashboard [subcommand]` — Open the status dashboard
- `ccmux doctor` — Diagnose the ccmux + Zellij + Claude Code environment
- `ccmux init` — Initialize `~/.ccmux/config.json`

## Install (WSL2 / Linux)

```bash
git clone https://github.com/thinkyou0714/ccmux
cd ccmux
npm install && npm run build
echo "alias ccmux='node $(pwd)/dist/index.js'" >> ~/.bashrc
source ~/.bashrc
ccmux init
```

## Config (`~/.ccmux/config.json`)

```json
{
  "defaultProject": "think-you-lab",
  "projects": {
    "think-you-lab": {
      "path": "/mnt/c/work/think-you-lab",
      "claudeMd": "/mnt/c/work/think-you-lab/lms/CLAUDE.md"
    }
  },
  "obsidian": {
    "apiKey": "YOUR_OBSIDIAN_LOCAL_REST_API_KEY",
    "baseUrl": "http://localhost:27123"
  }
}
```

### Obsidian over HTTPS (TLS)

ccmux verifies the TLS certificate on every Obsidian request, so the Bearer API
key can't leak to a man-in-the-middle. If your Obsidian Local REST API serves
HTTPS with a **self-signed** certificate, trust the cert rather than disabling
verification:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/obsidian-local-rest-api.pem
```

As a last-resort escape hatch you can set `"obsidian": { "allowInsecureTLS": true }`
in the config (default `false`). This skips certificate validation and logs a
warning on every request — only use it on a trusted local network.

### Copy untracked files into each worktree (`.worktreeinclude`)

A git worktree starts without your gitignored files (`.env`, local secrets, IDE
config). Put a `.worktreeinclude` (gitignore-style: one path per line, `#`
comments, no globs) in your **project root** and ccmux copies each listed file
into the new worktree at the same relative path. Entries that resolve outside
the project or the worktree are refused.

```
.env
config/secrets.json
.vscode/settings.json
```

## Environment variables

Most configuration lives in `~/.ccmux/config.json`; these env vars override or
supplement it (useful for tests, CI, and one-off runs). Precedence varies by
row — see the Default column (e.g. `OBSIDIAN_*` win over config, while
`CCMUX_WORKTREE_BASE` is only a fallback after `cfg.worktreeBase`):

| Variable | Purpose | Default |
|---|---|---|
| `CCMUX_DIR` | ccmux state directory (config, sessions, locks, logs, handoffs, queue) | `~/.ccmux` |
| `CCMUX_WORKTREE_BASE` | Base directory for created worktrees | `cfg.worktreeBase` → `~/worktrees` |
| `CCMUX_QUEUE_DISABLED` | `1` disables the SQLite webhook dedup queue (every claim wins) | unset |
| `CCMUX_SEND_DELAY_MS` | Grace period (ms) before typing the prompt into a freshly opened tab | `3000` |
| `CCMUX_TIMEZONE` | IANA zone for bucketing daily cost (matches `ccusage`) | system zone |
| `CCMUX_WEBHOOK_ALLOW_UNSANDBOXED` | `1` lets webhook-triggered autonomous runs skip the bubblewrap sandbox — runs untrusted issue text under `--dangerously-skip-permissions` (**not recommended**) | unset (sandbox required) |
| `OBSIDIAN_BASE_URL` / `OBSIDIAN_API_KEY` | Override the Obsidian REST endpoint / key at runtime | from config |
| `CLAUDE_CONFIG_DIR` | Where `ccusage` reads Claude usage data (auto-resolved under WSL2) | auto |
| `ZELLIJ_BIN` | Path to the `zellij` binary | `~/.local/bin/zellij` |
| `NODE_EXTRA_CA_CERTS` | Extra CA bundle to trust a self-signed Obsidian cert (see above) | unset |

## Requirements

- Node.js ≥ 22
- [Zellij](https://zellij.dev/) (optional — degrades gracefully without it)
- [Claude Code](https://claude.ai/code) CLI
- [ccusage](https://github.com/ryoppippi/ccusage) (optional — for cost display)
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin (optional)

## Why ccmux?

Most session managers depend on tmux. ccmux is built for Zellij-first workflows with n8n + Obsidian integration — allowing Claude Code to hand off context between sessions automatically.

## Claude Code で開発する (web / cloud 対応)

このリポジトリは **Claude Code on the web** に対応しています。

- 依存は `.claude/bootstrap.sh`（SessionStart）が `npm ci` で自動インストール（ローカルでは `node_modules` があれば no-op）。
- クラウドセッションは `AGENTS.md` と `.claude/skills/`（例: `run-tests`）を自動ロード。
- ccmux の実行系（Zellij/n8n/Obsidian）はローカル専用。クラウドはコードの読み書き・テスト用。
- MCP は本リポジトリではローカル専用。詳細は
  [`.github/docs/claude-code-web-readiness.md`](https://github.com/thinkyou0714/.github/blob/main/docs/claude-code-web-readiness.md)。
