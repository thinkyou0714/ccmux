import chalk from "chalk";
import ora from "ora";
import { createWorktree } from "../core/worktree.js";
import { openSession } from "../core/zellij.js";
import { createSession } from "../core/session.js";
import { acquireLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";

function autoName(): string {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5).replace(":", "");
  return `auto-${hhmm}`;
}

export async function autoCommand(name?: string): Promise<void> {
  const sessionName = name ?? autoName();
  const cfg = await loadConfig();
  const projectKey = cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    console.error(chalk.red(`defaultProject "${projectKey}" not found in config. Run: ccmux init`));
    process.exit(1);
  }

  const spinner = ora(`Auto-launching ccmux session "${sessionName}"...`).start();

  try {
    await acquireLock(sessionName);

    spinner.text = "Creating git worktree...";
    const wt = await createWorktree(sessionName, project.path);

    const session = await createSession({
      name: sessionName,
      branch: wt.branch,
      worktreePath: wt.path,
      projectPath: project.path,
      zellijTab: `ccmux:${sessionName}`,
      project: projectKey,
      llmBackend: project.defaultLlm,
    });

    // Launch CC with --dangerously-skip-permissions for autonomous mode
    const claudeCmd =
      project.defaultLlm === "autoclaw"
        ? `ANTHROPIC_BASE_URL="${cfg.autoclaw.url}" claude --dangerously-skip-permissions`
        : "claude --dangerously-skip-permissions";

    spinner.text = "Opening Zellij tab (autonomous mode)...";
    await openSession(sessionName, wt.path, claudeCmd);

    spinner.succeed(chalk.green(`Auto session "${sessionName}" launched`));
    console.log(
      [
        "",
        `  ${chalk.dim("id")}      ${session.id.slice(0, 8)}`,
        `  ${chalk.dim("branch")}  ${wt.branch}`,
        `  ${chalk.dim("path")}    ${wt.path}`,
        `  ${chalk.dim("mode")}    autonomous (--dangerously-skip-permissions)`,
        "",
        chalk.dim(`  Use \`ccmux list\` to monitor. \`ccmux close ${sessionName}\` when done.`),
        "",
      ].join("\n")
    );
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
