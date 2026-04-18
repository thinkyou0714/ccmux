import chalk from "chalk";
import ora from "ora";
import { getSession, updateSession } from "../core/session.js";
import { deleteWorktree, getWorktreeDiff } from "../core/worktree.js";
import { closeTab } from "../core/zellij.js";
import { releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { writeObsidianHandoff } from "../integrations/obsidian.js";

export interface CloseOptions {
  force?: boolean;
  noHandoff?: boolean;
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
    // 1. Get diff summary before deletion
    const diff = await getWorktreeDiff(session.worktreePath);

    // 2. Close the Zellij/tmux tab
    spinner.text = "Closing terminal tab...";
    await closeTab(name);

    // 3. Delete worktree (may throw if dirty and !force)
    spinner.text = "Removing worktree...";
    try {
      await deleteWorktree(name, session.projectPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("uncommitted") && !opts.force) {
        spinner.warn(chalk.yellow(`Worktree has uncommitted changes. Use --force to override.`));
        await updateSession(session.id, { status: "error" });
        process.exit(1);
      }
      if (!opts.force) throw err;
    }

    // 4. Write handoff
    if (!opts.noHandoff && cfg.obsidian.enabled) {
      spinner.text = "Writing Obsidian handoff...";
      await writeHandoff(session.name, session.branch, diff, cfg);
    } else if (!opts.noHandoff) {
      // Write to local file as fallback
      await writeLocalHandoff(session.name, session.branch, diff);
    }

    // 5. Update session status
    await updateSession(session.id, { status: "closed" });
    await releaseLock(name);

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

async function writeLocalHandoff(name: string, branch: string, diff: string): Promise<void> {
  const { default: fs } = await import("fs/promises");
  const { default: path } = await import("path");
  const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;
  const dir = path.join(CCMUX_DIR, "handoffs");
  await fs.mkdir(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}-${name}.md`);
  const content = [
    `# ccmux handoff: ${name}`,
    ``,
    `- date: ${new Date().toISOString()}`,
    `- branch: ${branch}`,
    ``,
    `## diff summary`,
    ``,
    diff || "(no changes)",
    ``,
  ].join("\n");

  await fs.writeFile(file, content, "utf-8");
  console.log(chalk.dim(`  handoff saved: ${file}`));
}

async function writeHandoff(
  name: string,
  branch: string,
  diff: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const ok = await writeObsidianHandoff(
    {
      sessionName: name,
      branch,
      diff,
      costUSD: 0,
      currency: cfg.cost.currency,
      exchangeRate: cfg.cost.exchangeRate,
    },
    cfg.obsidian
  );
  if (ok) {
    console.log(chalk.dim(`  handoff → Obsidian: ${cfg.obsidian.handoffPath}`));
  } else {
    await writeLocalHandoff(name, branch, diff);
  }
}
