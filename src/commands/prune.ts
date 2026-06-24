import chalk from "chalk";
import ora from "ora";
import { pruneOrphanedSessions, listSessions, updateSession } from "../core/session.js";
import { deleteWorktree } from "../core/worktree.js";
import { toErrorMessage } from "../core/errors.js";
import { loadConfig } from "../config/schema.js";

export interface PruneOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function pruneCommand(opts: PruneOptions): Promise<void> {
  const spinner = ora("Scanning for orphaned sessions...").start();

  try {
    await pruneOrphanedSessions();

    const sessions = await listSessions();
    const orphaned = sessions.filter((s) => s.status === "orphaned");

    spinner.stop();

    if (orphaned.length === 0) {
      console.log(chalk.green("No orphaned sessions found."));
      return;
    }

    console.log(`\nFound ${orphaned.length} orphaned session(s):\n`);

    for (const s of orphaned) {
      console.log(`  ${chalk.yellow(s.name.padEnd(20))} ${chalk.dim(s.worktreePath)}`);
    }

    if (opts.dryRun) {
      console.log(chalk.dim(`\n  (dry run — no changes made)`));
      return;
    }

    console.log();
    const removeSpinner = ora("Removing orphaned worktrees...").start();
    let removed = 0;
    const cfg = await loadConfig();

    for (const s of orphaned) {
      try {
        if (opts.force) {
          await deleteWorktreeForce(s.worktreePath, s.projectPath, s.name, cfg.worktreeBase);
        } else {
          await deleteWorktree(s.name, s.projectPath, { worktreeBase: cfg.worktreeBase });
        }
        await updateSession(s.id, { status: "closed" });
        removed++;
      } catch (err: unknown) {
        const msg = toErrorMessage(err);
        removeSpinner.warn(chalk.yellow(`  Skipped "${s.name}": ${msg}`));
        removeSpinner.start();
      }
    }

    removeSpinner.succeed(chalk.green(`Pruned ${removed} orphaned session(s).`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(toErrorMessage(err)));
    process.exit(1);
  }
}

async function deleteWorktreeForce(
  wtPath: string,
  projectPath: string,
  name: string,
  worktreeBase?: string,
): Promise<void> {
  const { execa } = await import("execa");
  // Resolution order mirrors core/worktree.resolveWorktreeBase:
  //   1. cfg.worktreeBase (passed by caller)  2. CCMUX_WORKTREE_BASE env  3. ${HOME}/worktrees
  const WORKTREE_BASE =
    worktreeBase ?? process.env.CCMUX_WORKTREE_BASE ?? `${process.env.HOME}/worktrees`;
  const fullWtPath = wtPath || `${WORKTREE_BASE}/${name}`;
  const branch = `ccmux/${name}`;

  await execa("git", ["-C", projectPath, "worktree", "remove", fullWtPath, "--force"], {
    stdio: "pipe",
  }).catch(() => {});

  await execa("git", ["-C", projectPath, "branch", "-D", branch], {
    stdio: "pipe",
  }).catch(() => {});
}
