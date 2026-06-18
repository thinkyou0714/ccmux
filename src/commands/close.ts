import chalk from "chalk";
import ora from "ora";
import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { getSession, updateSession } from "../core/session.js";
import { deleteWorktree, getWorktreeDiff } from "../core/worktree.js";
import { closeTab } from "../core/zellij.js";
import { releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { writeObsidianHandoff, exportSessionForDashboard } from "../integrations/obsidian.js";
import { completeSession } from "../core/queue.js";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}

export interface CloseOptions {
  force?: boolean;
  // commander negatable options: `--no-handoff` / `--no-dashboard` set these to
  // false; absent/true means run the step. (Previously read as non-existent
  // `noHandoff`/`noDashboard`, so the flags were silently ignored.)
  handoff?: boolean;
  dashboard?: boolean;
}

async function readClaudeMd(worktreePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(worktreePath, "CLAUDE.md"), "utf-8");
  } catch {
    return undefined;
  }
}

async function getGitLog(worktreePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["-C", worktreePath, "log", "--oneline", "-10"], { stdio: "pipe" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function extractTodos(claudeMdContent: string | undefined): string[] {
  if (!claudeMdContent) return [];
  return claudeMdContent
    .split("\n")
    .filter((l) => l.trimStart().startsWith("[ ] ") || l.trimStart().startsWith("- [ ] "))
    .map((l) => l.replace(/^\s*-?\s*\[\s*\]\s*/, "").trim())
    .filter(Boolean);
}

export async function closeCommand(name: string, opts: CloseOptions): Promise<void> {
  const cfg = await loadConfig();
  const session = await getSession(name);

  if (!session) {
    console.error(chalk.red(`Session "${name}" not found.`));
    process.exit(1);
  }

  const spinner = ora(`Closing session "${name}"...`).start();

  try {
    const diff = await getWorktreeDiff(session.worktreePath);

    spinner.text = "Gathering handoff data...";
    const claudeMdContent = await readClaudeMd(session.worktreePath);
    const gitLog = await getGitLog(session.worktreePath);
    const todos = extractTodos(claudeMdContent);

    spinner.text = "Closing terminal tab...";
    await closeTab(name);

    spinner.text = "Removing worktree...";
    try {
      await deleteWorktree(name, session.projectPath, {
        worktreeBase: cfg.worktreeBase,
        force: opts.force,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("uncommitted") && !opts.force) {
        spinner.warn(chalk.yellow(`Worktree has uncommitted changes. Use --force to override.`));
        await updateSession(session.id, { status: "error" });
        process.exit(1);
      }
      if (!opts.force) throw err;
    }

    if (opts.handoff !== false) {

      const handoffData = {
        sessionName: session.name,
        branch: session.branch,
        diff,
        costUSD: session.costUSD,
        currency: cfg.cost.currency,
        exchangeRate: cfg.cost.exchangeRate,
        claudeMdContent,
        todos,
        gitLog,
      };

      await writeLocalHandoff(handoffData);
      if (cfg.obsidian.enabled) {
        spinner.text = "Writing Obsidian handoff...";
        const ok = await writeObsidianHandoff(handoffData, cfg.obsidian);
        if (ok) {
          console.log(chalk.dim(`  handoff → Obsidian: ${cfg.obsidian.handoffPath}`));
        }
      }
    }

    await updateSession(session.id, { status: "closed" });
    await releaseLock(name);

    // BL-6: SQLite dedup queue — mark completed so the audit row reflects
    // close even though the dedup key stays held (deliberate, audit trail).
    try { completeSession(name); } catch { /* queue is opt-in, never block close */ }

    // BL-7: auto dashboard refresh — write the per-session markdown that
    // 05_OUTPUT/dashboards/ccmux-sessions.base reads. Silent + 3s timeout
    // so Obsidian REST unavailability never blocks the close path.
    if (cfg.obsidian.enabled && opts.dashboard !== false) {
      const rec = {
        id: session.id,
        name: session.name,
        status: "closed" as const,
        costUSD: session.costUSD,
        branch: session.branch,
        project: session.project,
        llmBackend: session.llmBackend,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
        worktreePath: session.worktreePath,
      };
      const t0 = Date.now();
      try {
        await Promise.race([
          exportSessionForDashboard(rec, {
            baseUrl: cfg.obsidian.baseUrl,
            apiKey: cfg.obsidian.apiKey,
          }),
          new Promise<never>((_, r) =>
            setTimeout(() => r(new Error("dashboard export timeout")), 3000)
          ),
        ]);
        if (Date.now() - t0 > 500) {
          console.log(chalk.dim(`  dashboard refresh: ${Date.now() - t0}ms`));
        }
      } catch {
        /* silent — auto dashboard is best-effort */
      }
    }

    const sym = cfg.cost.currency === "JPY" ? "¥" : "$";
    const cost =
      cfg.cost.currency === "JPY"
        ? `${sym}${Math.round(session.costUSD * cfg.cost.exchangeRate)}`
        : `${sym}${session.costUSD.toFixed(3)}`;

    spinner.succeed(chalk.green(`Session "${name}" closed`));
    console.log(`  total cost: ${cost}`);
    if (diff) console.log(chalk.dim(`\n  diff summary:\n${diff.split("\n").map((l) => "    " + l).join("\n")}`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}

export async function writeLocalHandoff(data: {
  sessionName: string;
  branch: string;
  diff: string;
  claudeMdContent?: string;
  todos?: string[];
  gitLog?: string;
}): Promise<void> {
  const dir = path.join(ccmuxDir(), "handoffs");
  await fs.mkdir(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}-${data.sessionName}.md`);

  const parts: string[] = [
    `# ccmux handoff: ${data.sessionName}`,
    ``,
    `- date: ${new Date().toISOString()}`,
    `- branch: ${data.branch}`,
    ``,
    `## diff summary`,
    ``,
    data.diff || "(no changes)",
  ];

  if (data.gitLog) {
    parts.push(``, `## git log`, ``, `\`\`\``, data.gitLog, `\`\`\``);
  }

  if (data.todos && data.todos.length > 0) {
    parts.push(``, `## todos`, ``);
    for (const todo of data.todos) parts.push(`- [ ] ${todo}`);
  }

  if (data.claudeMdContent) {
    parts.push(``, `## CLAUDE.md`, ``, data.claudeMdContent);
  }

  parts.push(``);

  await fs.writeFile(file, parts.join("\n"), "utf-8");
  console.log(chalk.dim(`  handoff saved: ${file}`));
}
