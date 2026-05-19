import chalk from "chalk";
import ora from "ora";
import { createSessionWorkflow, type NewWorkflowOptions } from "../services/session-service.js";

export type NewOptions = NewWorkflowOptions;

export async function newCommand(name: string, opts: NewOptions): Promise<void> {
  const spinner = ora(`Creating session "${name}"...`).start();

  try {
    const { session, worktree, llm } = await createSessionWorkflow(name, opts);
    spinner.succeed(chalk.green(`Session "${name}" started`));
    console.log(
      [
        "",
        `  ${chalk.dim("id")}       ${session.id.slice(0, 8)}`,
        `  ${chalk.dim("branch")}   ${worktree.branch}`,
        `  ${chalk.dim("path")}     ${worktree.path}`,
        `  ${chalk.dim("llm")}      ${llm}`,
        "",
      ].join("\n")
    );
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
