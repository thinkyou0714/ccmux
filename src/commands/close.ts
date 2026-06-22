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
  /**
   * Commander stores `--no-handoff` as `handoff: false` (default `true`), NOT as
   * `noHandoff`. The previous `opts.noHandoff` was always `undefined`, so the
   * handoff note was never actually skippable. Treat any value other than an
   * explicit `false` as "write the handoff".
   */
  handoff?: boolean;
  /** Likewise `--no-dashboard` → `dashboard: false`. */
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
    throw new Error(`Session "${name}" not found.`);
  }

  const spinner = ora(`Closing session "${name}"...`).start();

  try {
    const diff = await getWorktreeDiff(session.worktreePath);

    spinner.text = "Gathering handoff data...";
    const claudeMdContent = await readClaudeMd(session.worktreePath);
    const gitLog = await getGitLog(session.worktreePath);
    const todos = extractTodos(claudeMdContent);

    // F-01: pre-flight the uncommitted-changes guard BEFORE closing the tab.
    // closeTab must precede deleteWorktree (Windows can't remove a worktree dir
    // a live terminal still holds open), but if deleteWorktree were the first to
    // discover uncommitted changes we'd have already destroyed the user's tab
    // for a close we then refuse. Checking here leaves the tab — and the
    // uncommitted work — intact on refusal.
    if (!opts.force) {
      const { stdout: dirty } = await execa(
        "git",
        ["-C", session.worktreePath, "status", "--porcelain"],
        { stdio: "pipe" },
      ).catch(() => ({ stdout: "" }));
      if (dirty.trim()) {
        spinner.warn(chalk.yellow(`Worktree has uncommitted changes. Use --force to override.`));
        await updateSession(session.id, { status: "error" });
        throw new Error(`Worktree "${name}" has uncommitted changes. Use --force to override.`);
      }
    }

    spinner.text = "Closing terminal tab...";
    await closeTab(name);

    spinner.text = "Removing worktree...";
    try {
      await deleteWorktree(name, session.projectPath, {
        worktreeBase: cfg.worktreeBase,
        force: opts.force,
      });
    } catch (err: unknown) {
      // Uncommitted changes were already pre-checked above, so without --force
      // any error here is unexpected — propagate it. With --force, worktree
      // removal is best-effort (Windows handle quirks); don't fail over it.
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
    // REL-01: throw instead of process.exit so the serve daemon (n8n.ts) that
    // reuses closeCommand isn't killed by one failure. index.ts turns it into
    // exit 1. The `isSpinning` guard avoids double-printing when an inner branch
    // (e.g. the uncommitted-changes warn) already stopped the spinner.
    if (spinner.isSpinning) spinner.fail();
    // F-01: release the per-session lock on failure too (the success path
    // releases it below) so a refused/failed close doesn't leave the name locked.
    await releaseLock(name).catch(() => {});
    throw err;
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
