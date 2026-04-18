#!/usr/bin/env node
import { Command } from "commander";
import { newCommand } from "./commands/new.js";
import { listCommand } from "./commands/list.js";
import { closeCommand } from "./commands/close.js";
import { swapCommand } from "./commands/swap.js";
import { autoCommand } from "./commands/auto.js";
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
  .action(async (opts: { all?: boolean }) => {
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
  .action(async (name: string | undefined, opts: { prompt?: string; promptFile?: string }) => {
    await initConfig();
    if (opts.promptFile && !opts.prompt) {
      const { default: fs } = await import("fs/promises");
      opts.prompt = (await fs.readFile(opts.promptFile, "utf-8")).trim();
    }
    await autoCommand(name, opts);
  });

program
  .command("init")
  .description("Initialize ~/.ccmux/config.json with defaults")
  .action(async () => {
    await initConfig();
    console.log("ccmux initialized. Edit ~/.ccmux/config.json to add your projects.");
  });

program.parse(process.argv);
