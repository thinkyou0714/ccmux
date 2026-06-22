import chalk from "chalk";
import ora from "ora";
import { pruneOrphanedSessions, listSessions, updateSession } from "../core/session.js";
import { deleteWorktree } from "../core/worktree.js";
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
    // REL-06: an orphaned session's process died, so it almost always left
    // uncommitted work. Without --force, deleteWorktree's dirty-tree guard
    // throws and the orphan is silently skipped — stranded forever unless the
    // user happens to know about --force. Collect skips and surface a clear,
    // actionable summary so the dead-end is visible.
    const skipped: { name: string; path: string }[] = [];
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
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ name: s.name, path: s.worktreePath });
        removeSpinner.warn(chalk.yellow(`  Skipped "${s.name}": ${msg}`));
        removeSpinner.start();
      }
    }

    removeSpinner.succeed(chalk.green(`Pruned ${removed} orphaned session(s).`));

    if (skipped.length > 0) {
      console.log();
      console.log(
        chalk.yellow(
          `  ${skipped.length} orphan(s) skipped — likely uncommitted changes in a dead session:`
        )
      );
      for (const sk of skipped) {
        console.log(chalk.dim(`    ${sk.name}  →  ${sk.path}`));
      }
      console.log(
        chalk.dim(
          `  Recover any wanted work from those paths, then re-run with --force to remove them.`
        )
      );
    }
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
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
