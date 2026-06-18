import chalk from "chalk";
import ora from "ora";
import { createWorktree } from "../core/worktree.js";
import { openSession } from "../core/zellij.js";
import { createSession } from "../core/session.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { resolveClaudeCmd } from "../integrations/autoclaw.js";
import { jsonErr, jsonOk, printJson } from "../core/json-output.js";

export interface NewOptions {
  project?: string;
  llm?: "claude" | "autoclaw";
  json?: boolean;
}

export async function newCommand(name: string, opts: NewOptions): Promise<void> {
  const isJson = Boolean(opts.json);
  const cfg = await loadConfig();
  const projectKey = opts.project ?? cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    const msg = `Unknown project "${projectKey}". Check ~/.ccmux/config.json`;
    if (isJson) printJson(jsonErr(msg, { command: "new" }));
    else console.error(chalk.red(msg));
    process.exit(1);
  }

  const llm = opts.llm ?? project.defaultLlm;
  // --json: no spinner (its escape codes would pollute a piped stderr capture);
  // ora is a no-op when never started.
  const spinner = isJson ? null : ora(`Creating session "${name}"...`).start();

  try {
    await acquireLock(name);

    // 1. Create git worktree
    if (spinner) spinner.text = "Creating git worktree...";
    const wt = await createWorktree(name, project.path, { worktreeBase: cfg.worktreeBase });

    // 2. Determine the claude command
    const claudeCmd = await resolveClaudeCmd(llm);

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
    if (spinner) spinner.text = "Opening Zellij tab...";
    await openSession(name, wt.path, claudeCmd);

    if (isJson) {
      printJson(
        jsonOk(
          {
            id: session.id,
            name: session.name,
            branch: wt.branch,
            worktreePath: wt.path,
            project: projectKey,
            llm,
            status: session.status,
          },
          { command: "new" },
        ),
      );
      return;
    }

    spinner?.succeed(chalk.green(`Session "${name}" started`));
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
    const msg = String(err instanceof Error ? err.message : err);
    if (isJson) printJson(jsonErr(msg, { command: "new" }));
    else spinner?.fail(chalk.red(msg));
    process.exit(1);
  }
}
