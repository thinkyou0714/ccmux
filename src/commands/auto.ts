import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { createWorktree } from "../core/worktree.js";
import { openSession, sendToTab, getMuxInfo } from "../core/zellij.js";
import { createSession, updateSession } from "../core/session.js";
import { acquireLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { resolveClaudeCmd } from "../integrations/autoclaw.js";

const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;

function autoName(): string {
  const hhmm = new Date().toTimeString().slice(0, 5).replace(":", "");
  return `auto-${hhmm}`;
}

export interface AutoOptions {
  prompt?: string;  // Initial prompt to send to CC after startup
}

export async function autoCommand(name?: string, opts: AutoOptions = {}): Promise<void> {
  const sessionName = name ?? autoName();
  const cfg = await loadConfig();
  const projectKey = cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    console.error(chalk.red(`defaultProject "${projectKey}" not found. Run: ccmux init`));
    process.exit(1);
  }

  const { type: muxType } = getMuxInfo();
  const spinner = ora(`Auto-launching "${sessionName}" [${muxType}]...`).start();

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

    const baseClaudeCmd = await resolveClaudeCmd(project.defaultLlm);

    if (muxType !== "none") {
      // Inside Zellij or tmux — open tab, then send prompt
      const claudeCmd = `${baseClaudeCmd} --dangerously-skip-permissions`;
      spinner.text = "Opening tab...";
      await openSession(sessionName, wt.path, claudeCmd);
      await updateSession(session.id, { status: "starting" });

      if (opts.prompt) {
        spinner.text = "Waiting for CC to start, then sending prompt...";
        // sendToTab waits internally (default 3s) before typing
        await sendToTab(sessionName, opts.prompt);
        await updateSession(session.id, { status: "busy" });
        spinner.succeed(chalk.green(`"${sessionName}" launched → prompt sent to Zellij tab`));
      } else {
        await updateSession(session.id, { status: "idle" });
        spinner.succeed(chalk.green(`"${sessionName}" launched in Zellij (waiting for prompt)`));
      }
    } else {
      // Outside Zellij — daemon mode
      // If we have a prompt: run claude -p non-interactively and log output
      // If no prompt: write a startup script the user can attach to
      if (opts.prompt) {
        spinner.text = "Spawning daemon (claude -p)...";
        const logDir = path.join(CCMUX_DIR, "logs");
        await fs.mkdir(logDir, { recursive: true });
        const logFile = path.join(logDir, `${sessionName}.log`);

        const env = {
          ...process.env,
          CCMUX_SESSION: sessionName,
        };

        // Spawn detached background process
        const child = execa(
          "bash",
          [
            "-c",
            `cd "${wt.path}" && ${baseClaudeCmd} --dangerously-skip-permissions -p ${JSON.stringify(opts.prompt)} >> "${logFile}" 2>&1`,
          ],
          { detached: true, stdio: "ignore", env }
        );
        child.unref();

        await updateSession(session.id, { status: "busy", pid: child.pid });
        spinner.succeed(chalk.green(`"${sessionName}" running as daemon`));
        console.log(chalk.dim(`  log: ${logFile}`));
        console.log(chalk.dim(`  tail -f ${logFile}   to monitor`));
      } else {
        await updateSession(session.id, { status: "idle" });
        spinner.succeed(chalk.green(`"${sessionName}" worktree ready`));
        console.log(
          `\n  Start manually:\n  cd "${wt.path}" && ${baseClaudeCmd} --dangerously-skip-permissions\n`
        );
      }
    }

    console.log(
      [
        "",
        `  ${chalk.dim("id")}      ${session.id.slice(0, 8)}`,
        `  ${chalk.dim("branch")}  ${wt.branch}`,
        `  ${chalk.dim("path")}    ${wt.path}`,
        `  ${chalk.dim("mode")}    autonomous`,
        "",
        chalk.dim(`  ccmux list   →  monitor all sessions`),
        chalk.dim(`  ccmux close ${sessionName}  →  finish and write handoff`),
        "",
      ].join("\n")
    );
  } catch (err: unknown) {
    spinner.fail(chalk.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }
}
