#!/usr/bin/env node
import { Command } from "commander";
import { newCommand } from "./commands/new.js";
import { listCommand } from "./commands/list.js";
import { closeCommand } from "./commands/close.js";
import { swapCommand } from "./commands/swap.js";
import { autoCommand } from "./commands/auto.js";
import { serveCommand } from "./commands/serve.js";
import { doctorCommand } from "./commands/doctor.js";
import { pruneCommand } from "./commands/prune.js";
import { logsCommand } from "./commands/logs.js";
import { mergeCommand } from "./commands/merge.js";
import { reflectCommand } from "./commands/reflect.js";
import { initCommand } from "./commands/init.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { initConfig } from "./config/schema.js";
import { intArg, validateSessionName } from "./core/args.js";

const program = new Command();

program
  .name("ccmux")
  .description("Claude Code Multiplexer — Zellij × git worktree × n8n × Obsidian")
  .version("0.1.0");

program
  .command("new <name>")
  .description("Create a new CC session (worktree + Zellij tab + Claude Code)")
  .option("-p, --project <key>", "Project key from config (default: defaultProject)")
  .option("-l, --llm <backend>", "LLM backend: claude | autoclaw", "claude")
  .action(async (name: string, opts: { project?: string; llm?: "claude" | "autoclaw" }) => {
    validateSessionName(name);
    await initConfig();
    await newCommand(name, opts);
  });

program
  .command("list")
  .alias("ls")
  .description("List all active sessions")
  .option("-a, --all", "Include closed sessions")
  .option("-j, --json", "Output sessions as JSON")
  .option("--status <state>", "Filter by status (created|starting|idle|busy|done|closed|error|orphaned) — implies --all")
  .action(async (opts: { all?: boolean; json?: boolean; status?: string }) => {
    await initConfig();
    await listCommand(opts);
  });

program
  .command("close <name>")
  .alias("rm")
  .description("Close a session (worktree cleanup + Obsidian handoff)")
  .option("-f, --force", "Force close even with uncommitted changes")
  .option("--no-handoff", "Skip writing the handoff note")
  .option("--no-dashboard", "Skip the automatic Obsidian dashboard refresh (BL-7)")
  .action(async (name: string, opts: { force?: boolean; handoff?: boolean; dashboard?: boolean }) => {
    validateSessionName(name);
    await initConfig();
    await closeCommand(name, opts);
  });

program
  .command("swap <project>")
  .description("Hot-swap CLAUDE.md + settings.json to a different project context")
  .action(async (project: string) => {
    await initConfig();
    await swapCommand(project);
  });

program
  .command("auto [name]")
  .description("Auto-launch an autonomous CC session (--dangerously-skip-permissions)")
  .option("--prompt <text>", "Initial prompt to send to CC after startup")
  .option("--prompt-file <path>", "Read initial prompt from a file (avoids shell injection)")
  .option("--resume <name>", "Resume from the latest handoff of a closed session")
  .option("--loop", "Run in Ralph Loop mode: iterate until completion signal or max iterations")
  .option("--max-iter <n>", "Max iterations for --loop mode (default: 50)", intArg(1))
  .option("--until <pattern>", "Completion signal pattern for --loop (default: CCMUX_COMPLETE)")
  .option("--sandbox", "Wrap session in bubblewrap OS sandbox (Linux only; requires bwrap)")
  .action(async (name: string | undefined, opts: { prompt?: string; promptFile?: string; resume?: string; loop?: boolean; maxIter?: number; until?: string; sandbox?: boolean }) => {
    if (name) validateSessionName(name);
    if (opts.resume) validateSessionName(opts.resume);
    await initConfig();
    if (opts.promptFile && !opts.prompt) {
      const { default: fs } = await import("fs/promises");
      opts.prompt = (await fs.readFile(opts.promptFile, "utf-8")).trim();
    }
    await autoCommand(name, opts);
  });

program
  .command("serve")
  .description("Start HTTP webhook server for n8n integration (default port: 9090)")
  .option("-p, --port <number>", "Override listen port", intArg(1, 65535))
  .action(async (opts: { port?: number }) => {
    await initConfig();
    await serveCommand(opts);
  });

program
  .command("doctor")
  .description("Check dependencies and configuration")
  .action(async () => {
    await doctorCommand();
  });

program
  .command("prune")
  .description("Remove orphaned sessions and worktrees")
  .option("--dry-run", "Show what would be removed without deleting")
  .option("-f, --force", "Force remove even with uncommitted changes")
  .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
    await initConfig();
    await pruneCommand(opts);
  });

program
  .command("logs [name]")
  .description("View daemon session logs")
  .option("-f, --follow", "Follow log output in real time")
  .option("-n, --lines <number>", "Number of lines to show", intArg(1), 50)
  .option("-a, --all", "List all log files")
  .option("--clean", "Remove old log files")
  .option("--older-than <days>", "Days threshold for --clean", intArg(0), 30)
  .option("--dry-run", "Show what would be removed without deleting")
  .action(async (name: string | undefined, opts: { follow?: boolean; lines?: number; all?: boolean; clean?: boolean; olderThan?: number; dryRun?: boolean }) => {
    await initConfig();
    await logsCommand(name, opts);
  });

program
  .command("merge <name>")
  .description("Merge session branch into main and close")
  .option("--squash", "Squash commits before merging")
  .option("--no-ff", "No fast-forward merge")
  .option("--target <branch>", "Target branch (default: main or master)")
  .option("--keep", "Keep session open after merge")
  .option("--pr", "Create GitHub PR after push (requires gh CLI)")
  .option("--draft", "Create PR as draft")
  .option("--reviewer <user>", "Assign reviewer to PR")
  .action(async (name: string, opts: { squash?: boolean; ff?: boolean; target?: string; keep?: boolean; pr?: boolean; draft?: boolean; reviewer?: string }) => {
    validateSessionName(name);
    await initConfig();
    await mergeCommand(name, opts);
  });

program
  .command("reflect <name>")
  .description("Analyze a session log and generate CLAUDE.md improvement rules (Reflexion pattern)")
  .option("--apply", "Append generated rules to the project CLAUDE.md (review with git diff after)")
  .option("--backend <backend>", "LLM backend to use for reflection: claude | autoclaw", "claude")
  .option("--output-file <path>", "Write reflection output to a file instead of stdout")
  .action(async (name: string, opts: { apply?: boolean; backend?: "claude" | "autoclaw"; outputFile?: string }) => {
    await initConfig();
    await reflectCommand(name, opts);
  });

program
  .command("init")
  .description("Initialize ~/.ccmux/config.json (optionally bootstrap LiteLLM proxy in the same step)")
  .option("--with-litellm", "Create/detect Python venv at ~/.claude/litellm-venv, install litellm[proxy], generate a minimal local config, point ccmux at it")
  .option("--litellm-port <port>", "Port for the LiteLLM proxy (default 4101 — avoids the 3101 collision with Docker Desktop's autoclaw forward)", intArg(1, 65535))
  .option("-f, --force", "Re-create venv / overwrite litellm-config.yaml even when they already exist")
  .action(async (opts: { withLitellm?: boolean; litellmPort?: number; force?: boolean }) => {
    await initCommand(opts);
  });

program
  .command("dashboard [subcommand]")
  .description("Export sessions.json into the Obsidian Bases dashboard (subcommand: refresh)")
  .option("-a, --all", "Export every session in sessions.json (default: last 7 days)")
  .option("--data-path <path>", "Override vault data path (default: 05_OUTPUT/data/ccmux-sessions)")
  .option("--local-only", "Skip the Obsidian REST API and force local fallback (testing)")
  .action(async (subcommand: string | undefined, opts: { all?: boolean; dataPath?: string; localOnly?: boolean }) => {
    await initConfig();
    await dashboardCommand(subcommand, opts);
  });

// parseAsync (not parse) so rejections from async action handlers — e.g. an
// invalid config surfaced by loadConfig — propagate here instead of becoming an
// unhandled promise rejection (raw stack trace + opaque exit). We print the
// actionable message and exit non-zero; full stacks stay available under
// CCMUX_DEBUG=1 for genuine bugs.
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.CCMUX_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
