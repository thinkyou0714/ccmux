import chalk from "chalk";
import ora from "ora";
import { createWorktree } from "../core/worktree.js";
import { openSession } from "../core/zellij.js";
import { createSession } from "../core/session.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";

export interface NewOptions {
  project?: string;
  llm?: "claude" | "autoclaw";
}

export async function newCommand(name: string, opts: NewOptions): Promise<void> {
  const cfg = await loadConfig();
  const projectKey = opts.project ?? cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    console.error(chalk.red(`Unknown project "${projectKey}". Check ~/.ccmux/config.json`));
    process.exit(1);
  }

  const llm = opts.llm ?? project.defaultLlm;
  const spinner = ora(`Creating session "${name}"...`).start();

  try {
    await acquireLock(name);

    // 1. Create git worktree
    spinner.text = "Creating git worktree...";
    const wt = await createWorktree(name, project.path);

    // 2. Determine the claude command
    const claudeCmd =
      llm === "autoclaw"
        ? `ANTHROPIC_BASE_URL="${cfg.autoclaw.url}" claude`
        : "claude";

    // 3. Create session record
    const session = await createSession({
      name,
      branch: wt.branch,
      worktreePath: wt.path,
      projectPath: project.path,
      zellijTab: `ccmux:${name}`,
      project: projectKey,
      llmBackend: llm,
    });

    // 4. Open Zellij tab and start Claude Code
    spinner.text = "Opening Zellij tab...";
    await openSession(name, wt.path, claudeCmd);

    spinner.succeed(chalk.green(`Session "${name}" started`));
    console.log(
      [
        "",
        `  ${chalk.dim("id")}       ${session.id.slice(0, 8)}`,
        `  ${chalk.dim("branch")}   ${wt.branch}`,
        `  ${chalk.dim("path")}     ${wt.path}`,
        `  ${chalk.dim("llm")}      ${llm}`,
        "",
      ].join("\n")
    );
  } catch (err: unknown) {
    await releaseLock(name).catch(() => {});
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
