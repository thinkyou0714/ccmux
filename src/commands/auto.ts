import chalk from "chalk";
import ora from "ora";
import { autoSessionWorkflow, type AutoWorkflowOptions } from "../services/session-service.js";

export type AutoOptions = AutoWorkflowOptions;

export async function autoCommand(name?: string, opts: AutoOptions = {}): Promise<void> {
  const sessionName = name ?? "auto";
  const spinner = ora(`Auto-launching "${sessionName}"...`).start();

  try {
    const result = await autoSessionWorkflow(name, opts);
    if (result.muxType !== "none") {
      spinner.succeed(
        chalk.green(
          result.promptSent
            ? `"${result.sessionName}" launched → prompt sent to ${result.muxType} tab`
            : `"${result.sessionName}" launched in ${result.muxType} (waiting for prompt)`,
        ),
      );
    } else if (result.logFile) {
      spinner.succeed(chalk.green(`"${result.sessionName}" running as daemon${opts.loop ? " (loop)" : ""}`));
      console.log(chalk.dim(`  log: ${result.logFile}`));
      console.log(chalk.dim(`  tail -f ${result.logFile}   to monitor`));
      if (opts.loop) {
        console.log(chalk.dim(`  completion signal: "${result.until ?? "CCMUX_COMPLETE"}"`));
        console.log(chalk.dim(`  max iterations: ${result.maxIterations ?? 50}`));
      }
    } else {
      spinner.succeed(chalk.green(`"${result.sessionName}" worktree ready`));
      if (result.manualCommand) console.log(`\n  Start manually:\n  ${result.manualCommand}\n`);
    }

    console.log(
      [
        "",
        `  ${chalk.dim("id")}      ${result.session.id.slice(0, 8)}`,
        `  ${chalk.dim("branch")}  ${result.worktree.branch}`,
        `  ${chalk.dim("path")}    ${result.worktree.path}`,
        `  ${chalk.dim("mode")}    ${result.mode}`,
        "",
        chalk.dim(`  ccmux list   →  monitor all sessions`),
        chalk.dim(`  ccmux close ${result.sessionName}  →  finish and write handoff`),
        "",
      ].join("\n")
    );
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
