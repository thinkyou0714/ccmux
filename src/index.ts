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
import { initConfig } from "./config/schema.js";

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
    await initConfig();
    await newCommand(name, opts);
  });

program
  .command("list")
  .alias("ls")
  .description("List all active sessions")
  .option("-a, --all", "Include closed sessions")
  .option("-j, --json", "Output sessions as JSON")
  .action(async (opts: { all?: boolean; json?: boolean }) => {
    await initConfig();
    await listCommand(opts);
  });

program
  .command("close <name>")
  .alias("rm")
  .description("Close a session (worktree cleanup + Obsidian handoff)")
  .option("-f, --force", "Force close even with uncommitted changes")
  .option("--no-handoff", "Skip writing the handoff note")
  .action(async (name: string, opts: { force?: boolean; noHandoff?: boolean }) => {
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
  .action(async (name: string | undefined, opts: { prompt?: string; promptFile?: string; resume?: string }) => {
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
  .option("-p, --port <number>", "Override listen port", parseInt)
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
  .option("-n, --lines <number>", "Number of lines to show", parseInt, 50)
  .option("-a, --all", "List all log files")
  .option("--clean", "Remove old log files")
  .option("--older-than <days>", "Days threshold for --clean", parseInt, 30)
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
  .action(async (name: string, opts: { squash?: boolean; noFf?: boolean; target?: string; keep?: boolean; pr?: boolean; draft?: boolean; reviewer?: string }) => {
    await initConfig();
    await mergeCommand(name, opts);
  });

program
  .command("init")
  .description("Initialize ~/.ccmux/config.json with defaults")
  .action(async () => {
    await initConfig();
    console.log("ccmux initialized. Edit ~/.ccmux/config.json to add your projects.");
  });

program.parse(process.argv);
