import chalk from "chalk";
import ora from "ora";
import fs from "fs/promises";
import { loadConfig } from "../config/schema.js";

export async function swapCommand(projectKey: string): Promise<void> {
  const cfg = await loadConfig();
  const project = cfg.projects[projectKey];

  if (!project) {
    console.error(chalk.red(`Unknown project "${projectKey}". Available:`));
    for (const key of Object.keys(cfg.projects)) {
      console.error(`  ${key}`);
    }
    process.exit(1);
  }

  const spinner = ora(`Swapping context to "${projectKey}"...`).start();

  try {
    // Copy CLAUDE.md if defined
    if (project.claudeMd) {
      const dest = `${process.env.HOME}/.claude/CLAUDE.md`;
      await fs.copyFile(project.claudeMd, dest);
      spinner.text = `CLAUDE.md swapped from ${project.claudeMd}`;
    }

    // Copy settings.json if defined
    if (project.settings) {
      const dest = `${process.env.HOME}/.claude/settings.json`;
      await fs.copyFile(project.settings, dest);
      spinner.text = `settings.json swapped from ${project.settings}`;
    }

    cfg.defaultProject = projectKey;
    const { saveConfig } = await import("../config/schema.js");
    await saveConfig(cfg);

    spinner.succeed(chalk.green(`Context switched to "${projectKey}"`));
    console.log(chalk.dim(`  default project is now "${projectKey}"`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
