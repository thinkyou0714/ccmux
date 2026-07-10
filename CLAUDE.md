# ccmux Claude Code Guide

This file is the project-level guide for Claude Code sessions in this repository.
Keep it short, repo-specific, and grounded in files that exist here.

## Quick Start

- Runtime target: Node.js `>=22.13.0`.
- Package manager: npm with `package-lock.json` committed.
- Main entrypoint: `src/index.ts`.
- Build output: `dist/`.
- CLI binary after build: `ccmux` from `./dist/index.js`.
- Install dependencies with `npm install`.
- Run the TypeScript CLI through the package script `npm run dev`.
- Build with `npm run build`.
- Run unit tests with `npm run test`.
- Run lint with `npm run lint`.
- Run typechecking with `npm run typecheck`.
- Use `ccmux doctor` to inspect local runtime dependencies after the CLI is available.
- Runtime state is outside the repo under `~/.ccmux`.
- Do not read or print `.env`, `.env.local`, token, key, or credential files.
- Keep repository edits focused; generated runtime state is not source code.
- This repository is ESM TypeScript (`"type": "module"`).
- Prefer existing command/core/integration layers before adding new abstractions.

## Architecture

### CLI Boundary

- `src/index.ts` is the Commander-based CLI boundary.
- It registers all user-facing commands and their options.
- It imports command handlers from `src/commands/`.
- It calls `initConfig()` before commands that need config or runtime state.
- It catches thrown errors and prints command failures at the CLI edge.

### Commands Layer

- `src/commands/` contains user-facing workflows.
- Command modules should parse intent and delegate shared behavior to `src/core/`.
- `new.ts` creates worktrees, sessions, and multiplexer tabs.
- `auto.ts` creates autonomous sessions, installs hooks, writes `TASK_STATE.md`, and can run loop mode.
- `close.ts` closes sessions, captures handoff context, removes worktrees, and marks sessions closed.
- `list.ts` lists sessions and can include cost data.
- `serve.ts` starts the local HTTP API used by integrations.
- `merge.ts` merges a session worktree back to a target branch and can create a GitHub PR.
- `logs.ts` lists, tails, and cleans ccmux log files.
- `prune.ts` detects and removes orphaned sessions or worktrees.
- `reflect.ts` extracts lessons from logs or handoff files and can update project guidance.
- `dashboard.ts` exports session dashboard markdown.
- `doctor.ts` checks local dependencies and config health.
- `init.ts` creates initial `~/.ccmux/config.json` and optional LiteLLM support.
- `swap.ts` copies configured project Claude files into `~/.claude`.

### Core Layer

- `src/core/` holds shared local behavior.
- `session.ts` manages the session database in `~/.ccmux/sessions.json`.
- `lock.ts` provides per-session lock files under `~/.ccmux/locks`.
- `worktree.ts` creates, validates, diffs, and removes git worktrees.
- `hooks.ts` installs Claude hook files and a per-worktree `.claude/settings.json`.
- `taskstate.ts` reads and writes `TASK_STATE.md` for autonomous sessions.
- `queue.ts` stores webhook/session deduplication state in SQLite.
- `cost.ts` reads Claude usage with `ccusage` on a short cache.
- `zellij.ts` integrates with Zellij or tmux and falls back to manual commands.
- `errors.ts` defines shared error types.

### Integrations Layer

- `src/integrations/` contains external-system adapters.
- `n8n.ts` exposes local HTTP endpoints for session creation, listing, closing, and GitHub webhooks.
- `autoclaw.ts` builds and routes requests to the autoclaw provider.
- `obsidian.ts` writes handoffs and dashboard pages through the Obsidian Local REST API.
- Integration modules should keep network concerns out of command and core modules.

### Config And State

- `src/config/schema.ts` defines the persisted config shape and defaults.
- The config file is `~/.ccmux/config.json`.
- `saveConfig()` writes through a temporary file and rename.
- Project entries can define `path`, `claudeMd`, `settings`, and `defaultLlm`.
- Default worktrees are created under the configured `worktreeBase`.
- Session names are validated before they become paths or branch names.

## Commands

### Package Scripts

| Script | Command |
| --- | --- |
| `npm run build` | `tsc` |
| `npm run dev` | `tsx src/index.ts` |
| `npm run test` | `vitest run` |
| `npm run lint` | `eslint src tests` |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.test.json` |

Only use package scripts that exist in `package.json`.

### CLI Commands

| Command | Handler | Purpose |
| --- | --- | --- |
| `ccmux new <name>` | `src/commands/new.ts` | Create a session worktree and open it in the multiplexer. |
| `ccmux list` | `src/commands/list.ts` | List tracked sessions. |
| `ccmux close <name>` | `src/commands/close.ts` | Close a session and optionally hand off context. |
| `ccmux swap <project>` | `src/commands/swap.ts` | Copy project Claude files to the user Claude directory. |
| `ccmux auto [name]` | `src/commands/auto.ts` | Start an autonomous Claude session. |
| `ccmux serve` | `src/commands/serve.ts` | Start the local ccmux API server. |
| `ccmux merge <name>` | `src/commands/merge.ts` | Merge a session branch back to a target branch. |
| `ccmux logs [name]` | `src/commands/logs.ts` | Inspect or clean session logs. |
| `ccmux prune` | `src/commands/prune.ts` | Clean orphaned sessions and worktrees. |
| `ccmux reflect <name>` | `src/commands/reflect.ts` | Extract reusable guidance from a session. |
| `ccmux dashboard [subcommand]` | `src/commands/dashboard.ts` | Export dashboard markdown. |
| `ccmux doctor` | `src/commands/doctor.ts` | Check runtime dependencies and config. |
| `ccmux init` | `src/commands/init.ts` | Create initial config and optional LiteLLM files. |

## Testing

- Test runner: Vitest via `npm run test`.
- Typecheck target for tests: `tsconfig.test.json`.
- ESLint covers `src` and `tests`.
- CI runs on Ubuntu, Windows, and macOS with Node 22.
- CI installs with `npm ci`.
- CI runs audit, lint, typecheck, build, unit tests, and integration tests.
- Tests use temporary directories from `fs.mkdtemp()` under `os.tmpdir()`.
- Tests restore environment variables between cases.
- Tests commonly call `vi.resetModules()` when env-dependent paths are reloaded.
- Hook tests execute generated shell hooks with `spawnSync("bash", ...)`.
- Integration tests use `tests/integration/mock-llm-server.ts`.
- The mock LLM server binds `127.0.0.1` on an ephemeral port.
- Completion drift is checked by `tests/completions-drift.test.ts`.
- Completion files live in `completions/ccmux.bash` and `completions/_ccmux`.
- Avoid adding real network, real home-directory, or real Obsidian dependencies to tests.
- Use focused tests near the behavior being changed.

## Safety / Guardrails

- `src/core/worktree.ts` validates session names before path or branch use.
- Session names reject empty values, leading `-`, leading `/`, `.` or `..` segments, and unsupported characters.
- Worktree deletion checks for a dirty tree unless `--force` is supplied.
- `.worktreeinclude` copying rejects absolute paths, drive-letter paths, and `..` segments.
- `src/core/session.ts` writes session state through temporary files and mode `0600`.
- `src/core/lock.ts` uses exclusive lock files and checks stale process locks.
- `src/core/queue.ts` provides SQLite-backed deduplication for webhook-created sessions.
- `src/integrations/n8n.ts` limits request bodies before and during streaming.
- The local API binds to `127.0.0.1`.
- Bearer token comparison uses timing-safe comparison.
- GitHub webhook signatures use HMAC SHA-256 over the raw body.
- Webhook session creation uses the SQLite queue to avoid duplicate work.
- The HTTP server sets short header, request, and keep-alive timeouts.
- `src/core/hooks.ts` installs Claude hook files under each worktree `.claude/hooks/`.
- The stop hook blocks premature completion when `TASK_STATE.md` still has next steps.
- The stop hook has a circuit breaker controlled by `CCMUX_CIRCUIT_FIRES` and `CCMUX_CIRCUIT_WINDOW_SEC`.
- The stop hook captures best-effort `ccusage` cost unless `CCMUX_DISABLE_CCUSAGE=1`.
- The session-start hook re-injects `TASK_STATE.md` after Claude compaction.
- The pre-tool-use hook enforces a write boundary for write-capable tools.
- The pre-tool-use hook blocks writes outside the current worktree.
- The pre-tool-use hook (BL-2) blocks a curated set of destructive command tokens by substring-matching the full command: force pushes (`--force`/`-f`), `git reset --hard origin`, `git clean -fdx`, `rm -rf` of `/`/`~`/`--no-preserve-root`, `--no-verify` commits/pushes/merges, DB-destructive commands (`DROP`/`TRUNCATE`, `prisma migrate reset`, `drizzle-kit push --force`, `supabase db reset`), infra-destroy commands (`terraform destroy`, `kubectl delete namespace`, `docker … up -d` against prod), `npm`/`cargo publish`, and secret-file reads (`cat .env`/credentials/`id_rsa`).
- This is curated defense-in-depth, not a comprehensive filter: within each family only specific spellings match (e.g. `reset --hard` only against `origin`, `clean` only as `-fdx`) and it is bypassable — do not treat it as a security boundary.
- The destructive-command override is explicit through `CCMUX_BLOCKLIST_OVERRIDE=1`.
- Auto sessions can launch Claude with `--dangerously-skip-permissions`. In that mode Claude Code does NOT enforce `permissions.allow`/`permissions.deny`; the PreToolUse hook above is the only runtime guard. The committed `.claude/settings.json` allow/deny list applies to interactive (non-bypass) sessions and is advisory defense-in-depth.
- Obsidian TLS verification is on by default.
- `obsidian.allowInsecureTLS` is an explicit escape hatch and should not be enabled casually.
- Prefer `NODE_EXTRA_CA_CERTS` for trusted local Obsidian certificates.

## Extending

- Add new CLI behavior in a new or existing file under `src/commands/`.
- Register new user-facing commands and options in `src/index.ts`.
- Keep command handlers thin; move reusable filesystem, git, lock, or state logic into `src/core/`.
- Keep network and external API logic in `src/integrations/`.
- Use `loadConfig()` and `initConfig()` instead of hand-reading config files.
- Use `validateSessionName()` before a user-provided name becomes a path, branch, or file.
- Reuse lock and session helpers instead of writing ad hoc state files.
- Use `execa` for git and process calls, matching existing modules.
- Add or update Vitest coverage under `tests/` for changed behavior.
- Update completions in `completions/` when adding a user-facing command or option.
- Keep new safety-sensitive actions behind explicit flags such as `--force` or `--dry-run`.
- Do not add direct OpenAI or Anthropic network calls to n8n workflows; route through existing provider abstractions.
- Do not hardcode secrets, tokens, home paths, or machine-specific paths.
- If adding config fields, update defaults, merge behavior, and tests together.
- If adding autonomous-session behavior, update `TASK_STATE.md` handling and hook tests together.
- If adding a command that mutates git state, document the guardrail and add tests for refusal paths.
