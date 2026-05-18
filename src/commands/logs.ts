import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadConfig } from "../config/schema.js";
import { getSession } from "../core/session.js";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}

export interface LogsOptions {
  follow?: boolean;
  lines?: number;
  all?: boolean;
  clean?: boolean;
  olderThan?: number;
  dryRun?: boolean;
}

async function getLogFile(name: string): Promise<string | null> {
  const logDir = path.join(ccmuxDir(), "logs");
  const logFile = path.join(logDir, `${name}.log`);
  try {
    await fs.access(logFile);
    return logFile;
  } catch {
    return null;
  }
}

async function listAllLogs(): Promise<void> {
  const logDir = path.join(ccmuxDir(), "logs");
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    console.log(chalk.dim("No log directory found."));
    return;
  }

  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".log"));
  if (files.length === 0) {
    console.log(chalk.dim("No log files found."));
    return;
  }

  console.log("\nLog files:\n");
  for (const f of files) {
    const filePath = path.join(logDir, f.name);
    const stat = await fs.stat(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    const updated = stat.mtime.toISOString().slice(0, 19).replace("T", " ");
    console.log(`  ${f.name.padEnd(40)} ${sizeMB.padStart(8)} MB   ${updated}`);
  }
  console.log();
}

async function cleanLogs(opts: { olderThan?: number; dryRun?: boolean }): Promise<void> {
  const cfg = await loadConfig();
  const maxAgeDays = opts.olderThan ?? cfg.logs.maxAgeDays;
  const logDir = path.join(ccmuxDir(), "logs");

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    console.log(chalk.dim("No log directory found."));
    return;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".log"));

  let toDelete: string[] = [];
  for (const f of files) {
    const filePath = path.join(logDir, f.name);
    const stat = await fs.stat(filePath);
    const ageDays = (now - stat.mtime.getTime()) / (24 * 60 * 60 * 1000);
    const sizeMB = stat.size / (1024 * 1024);

    if (ageDays >= maxAgeDays || sizeMB > cfg.logs.maxSizeMB) {
      toDelete.push(filePath);
    }
  }

  if (toDelete.length === 0) {
    console.log(chalk.green("No log files to clean."));
    return;
  }

  console.log(`\nLog files to remove (${toDelete.length}):\n`);
  for (const f of toDelete) {
    console.log(`  ${chalk.dim(f)}`);
  }

  if (opts.dryRun) {
    console.log(chalk.dim("\n  (dry run — no files deleted)"));
    return;
  }

  for (const f of toDelete) {
    await fs.unlink(f);
  }
  console.log(chalk.green(`\nDeleted ${toDelete.length} log file(s).`));
}

export async function logsCommand(name: string | undefined, opts: LogsOptions): Promise<void> {
  if (opts.all) {
    await listAllLogs();
    return;
  }

  if (opts.clean) {
    await cleanLogs({ olderThan: opts.olderThan, dryRun: opts.dryRun });
    return;
  }

  if (!name) {
    console.error(chalk.red("Session name required. Use --all to list all logs."));
    process.exit(1);
  }

  const logFile = await getLogFile(name);

  if (!logFile) {
    const session = await getSession(name);
    if (session) {
      console.log(chalk.yellow(`No log file found for session "${name}".`));
      console.log(chalk.dim(`Session is in "${session.zellijTab}".`));
      if (process.env.ZELLIJ_SESSION_NAME) {
        console.log(chalk.dim(`  Attach: zellij action go-to-tab-name "${session.zellijTab}"`));
      } else if (process.env.TMUX) {
        console.log(chalk.dim(`  Attach: tmux select-window -t "${session.zellijTab}"`));
      }
    } else {
      console.error(chalk.red(`No log file or session found for "${name}".`));
      process.exit(1);
    }
    return;
  }

  const lines = opts.lines ?? 50;

  if (opts.follow) {
    const child = execa("tail", ["-f", logFile], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    await child;
    return;
  }

  const { stdout } = await execa("tail", ["-n", String(lines), logFile], { stdio: "pipe" });
  console.log(stdout);
}
