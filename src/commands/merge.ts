import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { getSession } from "../core/session.js";
import { getWorktreeDiff } from "../core/worktree.js";
import { closeCommand } from "./close.js";

export interface MergeOptions {
  squash?: boolean;
  // commander stores `--no-ff` as `ff: false` (absent/true = allow FF).
  ff?: boolean;
  target?: string;
  keep?: boolean;
  pr?: boolean;
  draft?: boolean;
  reviewer?: string;
}

export async function mergeCommand(name: string, opts: MergeOptions): Promise<void> {
  const spinner = ora(`Merging session "${name}"...`).start();

  try {
    const session = await getSession(name);
    if (!session) {
      spinner.fail(chalk.red(`Session "${name}" not found.`));
      process.exit(1);
    }

    spinner.text = "Getting diff summary...";
    const diff = await getWorktreeDiff(session.worktreePath);
    if (diff) {
      spinner.stop();
      console.log(chalk.dim("\nDiff summary:"));
      console.log(diff.split("\n").map((l) => "  " + l).join("\n"));
      console.log();
      spinner.start();
    }

    let targetBranch = opts.target;
    if (!targetBranch) {
      for (const candidate of ["main", "master"]) {
        try {
          await execa("git", ["-C", session.projectPath, "rev-parse", "--verify", candidate], { stdio: "pipe" });
          targetBranch = candidate;
          break;
        } catch {
          // branch not found, try next
        }
      }
      targetBranch ??= "main";
    }

    const branch = `ccmux/${name}`;
    const mergeArgs = ["merge"];
    if (opts.squash) mergeArgs.push("--squash");
    if (opts.ff === false) mergeArgs.push("--no-ff");
    mergeArgs.push(branch);

    spinner.text = `Merging ${branch} into ${targetBranch}...`;

    // Fixed locale so the "CONFLICT" check below isn't defeated by a localized
    // git (LANG=ja_JP etc.), and never block on a credential prompt.
    const gitEnv = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
    try {
      await execa("git", ["-C", session.projectPath, "checkout", targetBranch], { stdio: "pipe", env: gitEnv });
      await execa("git", ["-C", session.projectPath, ...mergeArgs], { stdio: "pipe", env: gitEnv });
      if (opts.squash) {
        await execa("git", ["-C", session.projectPath, "commit", "-m", `ccmux: squash merge ${branch}`], { stdio: "pipe", env: gitEnv });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        await execa("git", ["-C", session.projectPath, "merge", "--abort"], { stdio: "pipe", env: gitEnv }).catch(() => {});
        spinner.warn(chalk.yellow(`Merge conflict detected — merge aborted.`));
        console.log(chalk.dim(`  Resolve manually in: ${session.worktreePath}`));
        console.log(chalk.dim(`  Then re-run: ccmux merge ${name} --target ${targetBranch}`));
        process.exit(1);
      }
      throw err;
    }

    spinner.succeed(chalk.green(`Merged ${branch} into ${targetBranch}`));

    if (opts.pr) {
      await createPullRequest(session.projectPath, branch, targetBranch, name, opts);
    }

    if (!opts.keep) {
      // Write the handoff note on auto-close after a merge.
      await closeCommand(name, { handoff: true });
    }
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}

async function createPullRequest(
  projectPath: string,
  branch: string,
  targetBranch: string,
  name: string,
  opts: MergeOptions
): Promise<void> {
  try {
    await execa("gh", ["--version"], { stdio: "pipe" });
  } catch {
    console.log(chalk.yellow("  gh CLI not found — skipping PR creation"));
    return;
  }

  // Push the session branch so GitHub has a remote head to open the PR from
  try {
    await execa("git", ["-C", projectPath, "push", "-u", "origin", branch], { stdio: "pipe" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  Failed to push ${branch}: ${msg} — skipping PR creation`));
    return;
  }

  const prArgs = ["pr", "create", "--base", targetBranch, "--head", branch, "--title", `ccmux: ${name}`, "--body", `Session: ${name}`];
  if (opts.draft) prArgs.push("--draft");
  if (opts.reviewer) prArgs.push("--reviewer", opts.reviewer);

  try {
    const { stdout } = await execa("gh", prArgs, { cwd: projectPath, stdio: "pipe" });
    console.log(chalk.green(`  PR created: ${stdout.trim()}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  PR creation failed: ${msg}`));
  }
}
