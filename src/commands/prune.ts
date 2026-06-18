import chalk from "chalk";
import ora from "ora";
import { pruneOrphanedSessions, listSessions, updateSession } from "../core/session.js";
import { deleteWorktree } from "../core/worktree.js";
import { loadConfig } from "../config/schema.js";
import { jsonErr, jsonOk, printJson } from "../core/json-output.js";

export interface PruneOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

export async function pruneCommand(opts: PruneOptions): Promise<void> {
  const isJson = Boolean(opts.json);
  const spinner = isJson ? null : ora("Scanning for orphaned sessions...").start();

  try {
    await pruneOrphanedSessions();

    const sessions = await listSessions();
    const orphaned = sessions.filter((s) => s.status === "orphaned");

    spinner?.stop();

    const candidates = orphaned.map((s) => ({ name: s.name, worktreePath: s.worktreePath }));

    if (orphaned.length === 0) {
      if (isJson) {
        printJson(
          jsonOk({ removed: 0, candidates, skipped: [], dryRun: Boolean(opts.dryRun) }, { command: "prune" }),
        );
      } else {
        console.log(chalk.green("No orphaned sessions found."));
      }
      return;
    }

    if (opts.dryRun) {
      if (isJson) {
        printJson(
          jsonOk({ removed: 0, candidates, skipped: [], dryRun: true }, { command: "prune" }),
        );
        return;
      }
      console.log(`\nFound ${orphaned.length} orphaned session(s):\n`);
      for (const s of orphaned) {
        console.log(`  ${chalk.yellow(s.name.padEnd(20))} ${chalk.dim(s.worktreePath)}`);
      }
      console.log(chalk.dim(`\n  (dry run — no changes made)`));
      return;
    }

    if (!isJson) {
      console.log(`\nFound ${orphaned.length} orphaned session(s):\n`);
      for (const s of orphaned) {
        console.log(`  ${chalk.yellow(s.name.padEnd(20))} ${chalk.dim(s.worktreePath)}`);
      }
      console.log();
    }

    const removeSpinner = isJson ? null : ora("Removing orphaned worktrees...").start();
    let removed = 0;
    const skipped: { name: string; reason: string }[] = [];
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
        skipped.push({ name: s.name, reason: msg });
        if (removeSpinner) {
          removeSpinner.warn(chalk.yellow(`  Skipped "${s.name}": ${msg}`));
          removeSpinner.start();
        }
      }
    }

    if (isJson) {
      printJson(
        jsonOk(
          { removed, candidates, skipped, dryRun: false },
          { command: "prune", warnings: skipped.map((s) => `Skipped "${s.name}": ${s.reason}`) },
        ),
      );
      return;
    }

    removeSpinner?.succeed(chalk.green(`Pruned ${removed} orphaned session(s).`));
  } catch (err: unknown) {
    const msg = String(err instanceof Error ? err.message : err);
    if (isJson) printJson(jsonErr(msg, { command: "prune" }));
    else spinner?.fail(chalk.red(msg));
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
