import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { createWorktree } from "../core/worktree.js";
import { openSession, sendToTab, getMuxInfo } from "../core/zellij.js";
import { createSession, updateSession } from "../core/session.js";
import { acquireLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { resolveClaudeCmd, buildClaudeEnv } from "../integrations/autoclaw.js";
import { writeTaskState, taskStateClaudioPreamble } from "../core/taskstate.js";
import { installSessionHooks } from "../core/hooks.js";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}

function autoName(): string {
  const hhmm = new Date().toTimeString().slice(0, 5).replace(":", "");
  return `auto-${hhmm}`;
}

export interface AutoOptions {
  prompt?: string;
  resume?: string;
  loop?: boolean;
  maxIter?: number;
  until?: string;
  sandbox?: boolean;
}

export async function autoCommand(name?: string, opts: AutoOptions = {}): Promise<void> {
  if (opts.resume && !opts.prompt) {
    const handoffsDir = path.join(ccmuxDir(), "handoffs");
    try {
      const files = await fs.readdir(handoffsDir);
      const matches = files.filter((f) => f.endsWith(`-${opts.resume}.md`)).sort();
      if (matches.length > 0) {
        const latest = path.join(handoffsDir, matches[matches.length - 1]);
        const content = await fs.readFile(latest, "utf-8");
        opts.prompt = `前セッション ${opts.resume} の続きです:\n\n${content}`;
      }
    } catch {
      // handoffs dir not found — proceed without resume prompt
    }
  }

  const sessionName = name ?? autoName();
  const cfg = await loadConfig();
  const projectKey = cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    throw new Error(`defaultProject "${projectKey}" not found. Run: ccmux init`);
  }

  const { type: muxType } = getMuxInfo();
  const spinner = ora(`Auto-launching "${sessionName}" [${muxType}]...`).start();

  try {
    await acquireLock(sessionName);

    spinner.text = "Creating git worktree...";
    const wt = await createWorktree(sessionName, project.path, { worktreeBase: cfg.worktreeBase });

    const session = await createSession({
      name: sessionName,
      branch: wt.branch,
      worktreePath: wt.path,
      projectPath: project.path,
      zellijTab: `ccmux:${sessionName}`,
      project: projectKey,
      llmBackend: project.defaultLlm,
    });

    // Write TASK_STATE.md for autonomous sessions that have a prompt
    if (opts.prompt) {
      await writeTaskState(wt.path, {
        sessionName,
        goal: opts.prompt.slice(0, 500), // cap goal length in state file
        iteration: 0,
        maxIterations: opts.maxIter ?? (opts.loop ? 50 : 1),
        status: "running",
        completedSteps: [],
        nextSteps: [],
        lastUpdated: new Date().toISOString(),
      });

      // Install Stop + SessionStart + PreToolUse hooks for autonomous sessions
      await installSessionHooks(wt.path, sessionName, opts.maxIter ?? (opts.loop ? 50 : 1));
    }

    // Create .claude/tools/ directory for agent self-synthesized tools
    await fs.mkdir(path.join(wt.path, ".claude", "tools"), { recursive: true });

    const baseClaudeCmd = await resolveClaudeCmd(project.defaultLlm);

    if (muxType !== "none") {
      // Inside Zellij or tmux — open tab, then send prompt
      const claudeCmd = `${baseClaudeCmd} --dangerously-skip-permissions`;
      spinner.text = "Opening tab...";
      await openSession(sessionName, wt.path, claudeCmd);
      await updateSession(session.id, { status: "starting" });

      if (opts.prompt) {
        // Prepend TASK_STATE preamble for loop-mode sessions
        const fullPrompt = opts.loop
          ? taskStateClaudioPreamble(sessionName) + opts.prompt
          : opts.prompt;

        spinner.text = "Waiting for CC to start, then sending prompt...";
        await sendToTab(sessionName, fullPrompt);
        await updateSession(session.id, { status: "busy" });
        spinner.succeed(chalk.green(`"${sessionName}" launched → prompt sent to Zellij tab`));
      } else {
        await updateSession(session.id, { status: "idle" });
        spinner.succeed(chalk.green(`"${sessionName}" launched in Zellij (waiting for prompt)`));
      }
    } else {
      // Outside Zellij — daemon mode
      if (opts.prompt) {
        const logDir = path.join(ccmuxDir(), "logs");
        await fs.mkdir(logDir, { recursive: true });
        const logFile = path.join(logDir, `${sessionName}.log`);

        const env = buildClaudeEnv(project.defaultLlm, cfg, sessionName);

        if (opts.loop) {
          // Ralph Loop: iterate until completion promise found or max iterations reached
          await spawnLoopDaemon({
            sessionName,
            prompt: opts.prompt,
            worktreePath: wt.path,
            logFile,
            env,
            maxIter: opts.maxIter ?? 50,
            until: opts.until ?? "CCMUX_COMPLETE",
            sandbox: opts.sandbox,
          });
          spinner.text = "Loop daemon spawned";
        } else {
          // Single-shot daemon
          const promptFile = path.join(wt.path, "TASK_PROMPT.md");
          await fs.writeFile(promptFile, opts.prompt, "utf-8");

          const { bin, args: launchArgs } = buildLaunchArgs(
            ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
            wt.path,
            opts.sandbox
          );

          const logHandle = await fs.open(logFile, "a");
          // On Windows, claude is a .cmd shim — child_process.spawn must use
          // shell:true to resolve and run .cmd/.bat through cmd.exe.
          const useShell = process.platform === "win32";
          const child = spawn(bin, launchArgs, {
            cwd: wt.path,
            detached: true,
            stdio: ["ignore", logHandle.fd, logHandle.fd],
            env,
            shell: useShell,
          });
          child.unref();
          await logHandle.close();
          await updateSession(session.id, { status: "busy", pid: child.pid });
        }

        spinner.succeed(chalk.green(`"${sessionName}" running as daemon${opts.loop ? " (loop)" : ""}`));
        console.log(chalk.dim(`  log: ${logFile}`));
        console.log(chalk.dim(`  tail -f ${logFile}   to monitor`));
        if (opts.loop) {
          console.log(chalk.dim(`  completion signal: "${opts.until ?? "CCMUX_COMPLETE"}"`));
          console.log(chalk.dim(`  max iterations: ${opts.maxIter ?? 50}`));
        }
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
        `  ${chalk.dim("mode")}    ${opts.loop ? "autonomous loop" : "autonomous"}`,
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

interface LoopDaemonOpts {
  sessionName: string;
  prompt: string;
  worktreePath: string;
  logFile: string;
  env: Record<string, string>;
  maxIter: number;
  until: string;
  sandbox?: boolean;
}

async function spawnLoopDaemon(opts: LoopDaemonOpts): Promise<void> {
  const { worktreePath, logFile, env, maxIter, until, prompt, sessionName } = opts;

  // Write prompt and loop script to worktree (no shell-injected values)
  const promptFile = path.join(worktreePath, "TASK_PROMPT.md");
  const preamble = taskStateClaudioPreamble(sessionName);
  await fs.writeFile(promptFile, preamble + prompt, "utf-8");

  const loopScript = path.join(worktreePath, ".ccmux-loop.sh");
  const { bin: claudeBin, args: claudeSandboxArgs } = buildLaunchArgs(
    ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
    worktreePath,
    opts.sandbox
  );
  const claudeInvocation = [claudeBin, ...claudeSandboxArgs]
    .map((a) => `"${a.replace(/"/g, '\\"')}"`)
    .join(" ");

  const scriptContent = [
    `#!/usr/bin/env bash`,
    `set -euo pipefail`,
    `MAX_ITER="${maxIter}"`,
    `UNTIL_PATTERN="${until.replace(/"/g, '\\"')}"`,
    `LOGFILE="${logFile.replace(/"/g, '\\"')}"`,
    `ITER=0`,
    `while [ "$ITER" -lt "$MAX_ITER" ]; do`,
    `  ITER=$((ITER + 1))`,
    `  echo "=== ccmux loop iteration $ITER / $MAX_ITER ===" >> "$LOGFILE"`,
    `  ${claudeInvocation} >> "$LOGFILE" 2>&1 || true`,
    `  if grep -qF "$UNTIL_PATTERN" "$LOGFILE"; then`,
    `    echo "=== CCMUX_LOOP_COMPLETE ===" >> "$LOGFILE"`,
    `    exit 0`,
    `  fi`,
    `done`,
    `echo "=== CCMUX_LOOP_MAX_ITER_REACHED ===" >> "$LOGFILE"`,
  ].join("\n") + "\n";

  await fs.writeFile(loopScript, scriptContent, { mode: 0o755 });

  const logHandle = await fs.open(logFile, "a");
  const child = spawn("bash", [loopScript], {
    cwd: worktreePath,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env,
  });
  child.unref();
  await logHandle.close();
}

/**
 * Optionally wrap the claude invocation in bubblewrap for OS-level sandboxing.
 * git worktrees share the object store and do NOT isolate the filesystem —
 * bubblewrap is the only reliable containment for --dangerously-skip-permissions.
 *
 * Requires: bwrap (bubblewrap) installed on the system.
 */
function buildLaunchArgs(
  claudeArgs: string[],
  worktreePath: string,
  sandbox?: boolean
): { bin: string; args: string[] } {
  if (!sandbox) {
    return { bin: "claude", args: claudeArgs };
  }

  // bubblewrap sandbox: bind-mount worktree as /workspace, share /usr /lib /bin,
  // no network (--unshare-net), no new privs, tmpfs home overlay.
  const bwrapArgs = [
    "--unshare-pid",
    "--unshare-net",      // block network (forces local-LLM-only via env vars)
    "--unshare-uts",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/passwd", "/etc/passwd",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/root",
    "--bind", worktreePath, "/workspace",
    "--chdir", "/workspace",
    "--new-session",
    "--die-with-parent",
    "claude",
    ...claudeArgs,
  ];

  return { bin: "bwrap", args: bwrapArgs };
}
