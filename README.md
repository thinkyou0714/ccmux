# ccmux — Claude Code Multiplexer

Zellij × git worktree × Obsidian integration for managing parallel Claude Code sessions.

## Features

- `ccmux new <name>` — Create a session: git worktree + Zellij tab + Claude Code
- `ccmux list` — Show active sessions + today's API cost (via ccusage)
- `ccmux close <name>` — Close session + write Obsidian handoff note
- `ccmux swap <project>` — Hot-swap `CLAUDE.md` + `settings.json` to another project
- `ccmux auto [name]` — Launch autonomous CC session (detached daemon or Zellij tab)
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

## Requirements

- Node.js ≥ 22
- [Zellij](https://zellij.dev/) (optional — degrades gracefully without it)
- [Claude Code](https://claude.ai/code) CLI
- [ccusage](https://github.com/ryoppippi/ccusage) (optional — for cost display)
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin (optional)

## Why ccmux?

Most session managers depend on tmux. ccmux is built for Zellij-first workflows with n8n + Obsidian integration — allowing Claude Code to hand off context between sessions automatically.
