import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { getSession } from "../core/session.js";
import { getWorktreeDiff } from "../core/worktree.js";
import { closeCommand } from "./close.js";

export interface MergeOptions {
  squash?: boolean;
  /**
   * Commander stores `--no-ff` as `ff: false` (default `true`), NOT as `noFf`.
   * The previous `opts.noFf` was always `undefined`, so `--no-ff` silently did
   * nothing. Push `--no-ff` only when the user explicitly disabled fast-forward.
   */
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
      throw new Error(`Session "${name}" not found.`);
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

    // SEC-03: targetBranch can come from the user `--target` flag. `git checkout`
    // has no option terminator (it reads `--`/`--end-of-options` as a pathspec),
    // so guard against a leading-dash branch being parsed as a flag instead.
    if (targetBranch.startsWith("-")) {
      throw new Error(`refusing to merge into a branch whose name starts with '-': "${targetBranch}"`);
    }

    const branch = `ccmux/${name}`;
    const mergeArgs = ["merge"];
    if (opts.squash) mergeArgs.push("--squash");
    if (opts.ff === false) mergeArgs.push("--no-ff");
    // SEC-03: `--` terminates options before the source branch name.
    mergeArgs.push("--", branch);

    spinner.text = `Merging ${branch} into ${targetBranch}...`;

    try {
      await execa("git", ["-C", session.projectPath, "checkout", targetBranch], { stdio: "pipe" });
      await execa("git", ["-C", session.projectPath, ...mergeArgs], { stdio: "pipe" });
      if (opts.squash) {
        await execa("git", ["-C", session.projectPath, "commit", "-m", `ccmux: squash merge ${branch}`], { stdio: "pipe" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        await execa("git", ["-C", session.projectPath, "merge", "--abort"], { stdio: "pipe" }).catch(() => {});
        spinner.warn(chalk.yellow(`Merge conflict detected — merge aborted.`));
        console.log(chalk.dim(`  Resolve manually in: ${session.worktreePath}`));
        console.log(chalk.dim(`  Then re-run: ccmux merge ${name} --target ${targetBranch}`));
        throw new Error(undefined, { cause: err }); // conflict reported above; exit 1
      }
      throw err;
    }

    spinner.succeed(chalk.green(`Merged ${branch} into ${targetBranch}`));

    if (opts.pr) {
      await createPullRequest(session.projectPath, branch, targetBranch, name, opts);
    }

    if (!opts.keep) {
      await closeCommand(name, { handoff: true });
    }
  } catch (err: unknown) {
    // F-02/REL-01: surface the message once here, then throw so the index.ts
    // CLI boundary exits 1 — instead of process.exit, which would kill an
    // in-process caller (e.g. the serve daemon). Empty message = already shown.
    const m = err instanceof Error ? err.message : String(err);
    if (m) spinner.fail(chalk.red(m));
    throw new Error(undefined, { cause: err });
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
