import chalk from "chalk";
import ora from "ora";
import { closeSessionWorkflow, type CloseWorkflowOptions } from "../services/session-service.js";

export type CloseOptions = CloseWorkflowOptions;

export async function closeCommand(name: string, opts: CloseOptions): Promise<void> {
  const spinner = ora(`Closing session "${name}"...`).start();

  try {
    const result = await closeSessionWorkflow(name, opts);
    spinner.succeed(chalk.green(`Session "${name}" closed`));
    if (result.handoffPath) console.log(chalk.dim(`  handoff saved: ${result.handoffPath}`));
    if (result.obsidianHandoffPath) console.log(chalk.dim(`  handoff → Obsidian: ${result.obsidianHandoffPath}`));
    if (result.dashboardRefreshMs !== undefined && result.dashboardRefreshMs > 500) {
      console.log(chalk.dim(`  dashboard refresh: ${result.dashboardRefreshMs}ms`));
    }
    console.log(`  total cost: ${result.cost}`);
    if (result.diff) {
      console.log(chalk.dim(`\n  diff summary:\n${result.diff.split("\n").map((l) => "    " + l).join("\n")}`));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("uncommitted")) {
      spinner.warn(chalk.yellow(message));
    } else {
      spinner.fail(chalk.red(message));
    }
    process.exit(1);
  }
}
