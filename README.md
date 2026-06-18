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
warning on every request — only use it on a trusted local network. For safety it
**only applies to loopback hosts** (`127.0.0.0/8`, `::1`, `localhost`); for any
other host TLS verification is enforced regardless and the flag is ignored (with
a warning), so the API key can't leak to a MITM on a remote Obsidian endpoint.

## Requirements

- Node.js ≥ 22
- [Zellij](https://zellij.dev/) (optional — degrades gracefully without it)
- [Claude Code](https://claude.ai/code) CLI
- [ccusage](https://github.com/ryoppippi/ccusage) (optional — for cost display)
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin (optional)

## Why ccmux?

Most session managers depend on tmux. ccmux is built for Zellij-first workflows with n8n + Obsidian integration — allowing Claude Code to hand off context between sessions automatically.
