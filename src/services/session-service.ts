import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { spawn } from "child_process";
import { loadConfig } from "../config/schema.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { createSession, getSession, type Session, updateSession } from "../core/session.js";
import { installSessionHooks } from "../core/hooks.js";
import { completeSession } from "../core/queue.js";
import { taskStateClaudioPreamble, writeTaskState } from "../core/taskstate.js";
import { createWorktree, deleteWorktree, getWorktreeDiff, type WorktreeInfo } from "../core/worktree.js";
import { closeTab, getMuxInfo, openSession, sendToTab, type Multiplexer } from "../core/zellij.js";
import { buildClaudeEnv, resolveClaudeCmd } from "../integrations/autoclaw.js";
import { exportSessionForDashboard, writeObsidianHandoff } from "../integrations/obsidian.js";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}

export class SessionWorkflowError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = "SESSION_WORKFLOW_ERROR",
  ) {
    super(message);
    this.name = "SessionWorkflowError";
  }
}

export interface NewWorkflowOptions {
  project?: string;
  llm?: "claude" | "autoclaw";
}

export interface NewWorkflowResult {
  session: Session;
  worktree: WorktreeInfo;
  llm: "claude" | "autoclaw";
}

export async function createSessionWorkflow(name: string, opts: NewWorkflowOptions = {}): Promise<NewWorkflowResult> {
  const cfg = await loadConfig();
  const projectKey = opts.project ?? cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    throw new SessionWorkflowError(`Unknown project "${projectKey}". Check ~/.ccmux/config.json`, 400, "UNKNOWN_PROJECT");
  }

  const llm = opts.llm ?? project.defaultLlm;

  try {
    await acquireLock(name);
    const worktree = await createWorktree(name, project.path, { worktreeBase: cfg.worktreeBase });
    const claudeCmd = await resolveClaudeCmd(llm);
    const session = await createSession({
      name,
      branch: worktree.branch,
      worktreePath: worktree.path,
      projectPath: project.path,
      zellijTab: `ccmux:${name}`,
      project: projectKey,
      llmBackend: llm,
    });

    await openSession(name, worktree.path, claudeCmd);
    return { session, worktree, llm };
  } catch (err: unknown) {
    await releaseLock(name).catch(() => {});
    throw err;
  }
}

export interface CloseWorkflowOptions {
  force?: boolean;
  noHandoff?: boolean;
  noDashboard?: boolean;
}

export interface CloseWorkflowResult {
  session: Session;
  diff: string;
  cost: string;
  handoffPath?: string;
  obsidianHandoffPath?: string;
  dashboardRefreshMs?: number;
}

async function readClaudeMd(worktreePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(worktreePath, "CLAUDE.md"), "utf-8");
  } catch {
    return undefined;
  }
}

async function getGitLog(worktreePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["-C", worktreePath, "log", "--oneline", "-10"], { stdio: "pipe" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function extractTodos(claudeMdContent: string | undefined): string[] {
  if (!claudeMdContent) return [];
  return claudeMdContent
    .split("\n")
    .filter((l) => l.trimStart().startsWith("[ ] ") || l.trimStart().startsWith("- [ ] "))
    .map((l) => l.replace(/^\s*-?\s*\[\s*\]\s*/, "").trim())
    .filter(Boolean);
}

async function writeLocalHandoff(data: {
  sessionName: string;
  branch: string;
  diff: string;
  claudeMdContent?: string;
  todos?: string[];
  gitLog?: string;
}): Promise<string> {
  const dir = path.join(ccmuxDir(), "handoffs");
  await fs.mkdir(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}-${data.sessionName}.md`);
  const parts: string[] = [
    `# ccmux handoff: ${data.sessionName}`,
    ``,
    `- date: ${new Date().toISOString()}`,
    `- branch: ${data.branch}`,
    ``,
    `## diff summary`,
    ``,
    data.diff || "(no changes)",
  ];

  if (data.gitLog) parts.push(``, `## git log`, ``, "```", data.gitLog, "```");
  if (data.todos && data.todos.length > 0) {
    parts.push(``, `## todos`, ``);
    for (const todo of data.todos) parts.push(`- [ ] ${todo}`);
  }
  if (data.claudeMdContent) parts.push(``, `## CLAUDE.md`, ``, data.claudeMdContent);
  parts.push(``);

  await fs.writeFile(file, parts.join("\n"), "utf-8");
  return file;
}

function formatCost(session: Session, cfg: Awaited<ReturnType<typeof loadConfig>>): string {
  const sym = cfg.cost.currency === "JPY" ? "¥" : "$";
  return cfg.cost.currency === "JPY"
    ? `${sym}${Math.round(session.costUSD * cfg.cost.exchangeRate)}`
    : `${sym}${session.costUSD.toFixed(3)}`;
}

export async function closeSessionWorkflow(name: string, opts: CloseWorkflowOptions = {}): Promise<CloseWorkflowResult> {
  const cfg = await loadConfig();
  const session = await getSession(name);

  if (!session) {
    throw new SessionWorkflowError(`Session "${name}" not found.`, 404, "SESSION_NOT_FOUND");
  }

  const diff = await getWorktreeDiff(session.worktreePath);
  const claudeMdContent = await readClaudeMd(session.worktreePath);
  const gitLog = await getGitLog(session.worktreePath);
  const todos = extractTodos(claudeMdContent);

  await closeTab(name);

  try {
    await deleteWorktree(name, session.projectPath, { worktreeBase: cfg.worktreeBase });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uncommitted") && !opts.force) {
      await updateSession(session.id, { status: "error" });
      throw new SessionWorkflowError("Worktree has uncommitted changes. Use --force to override.", 409, "UNCOMMITTED_CHANGES");
    }
    if (!opts.force) throw err;
  }

  let handoffPath: string | undefined;
  let obsidianHandoffPath: string | undefined;
  if (!opts.noHandoff) {
    const handoffData = {
      sessionName: session.name,
      branch: session.branch,
      diff,
      costUSD: session.costUSD,
      currency: cfg.cost.currency,
      exchangeRate: cfg.cost.exchangeRate,
      claudeMdContent,
      todos,
      gitLog,
    };

    handoffPath = await writeLocalHandoff(handoffData);
    if (cfg.obsidian.enabled) {
      const ok = await writeObsidianHandoff(handoffData, cfg.obsidian);
      if (ok) obsidianHandoffPath = cfg.obsidian.handoffPath;
    }
  }

  const closed = await updateSession(session.id, { status: "closed" });
  await releaseLock(name);
  try { completeSession(name); } catch { /* queue is opt-in, never block close */ }

  let dashboardRefreshMs: number | undefined;
  if (cfg.obsidian.enabled && !opts.noDashboard) {
    const rec = {
      id: session.id,
      name: session.name,
      status: "closed" as const,
      costUSD: session.costUSD,
      branch: session.branch,
      project: session.project,
      llmBackend: session.llmBackend,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      worktreePath: session.worktreePath,
    };
    const t0 = Date.now();
    try {
      await Promise.race([
        exportSessionForDashboard(rec, { baseUrl: cfg.obsidian.baseUrl, apiKey: cfg.obsidian.apiKey }),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("dashboard export timeout")), 3000)),
      ]);
      dashboardRefreshMs = Date.now() - t0;
    } catch {
      /* silent — auto dashboard is best-effort */
    }
  }

  return { session: closed, diff, cost: formatCost(session, cfg), handoffPath, obsidianHandoffPath, dashboardRefreshMs };
}

export interface AutoWorkflowOptions {
  prompt?: string;
  resume?: string;
  loop?: boolean;
  maxIter?: number;
  until?: string;
  sandbox?: boolean;
}

export interface AutoWorkflowResult {
  sessionName: string;
  session: Session;
  worktree: WorktreeInfo;
  mode: "autonomous" | "autonomous loop";
  muxType: Multiplexer;
  logFile?: string;
  until?: string;
  maxIterations?: number;
  manualCommand?: string;
  promptSent: boolean;
}

function autoName(): string {
  const hhmm = new Date().toTimeString().slice(0, 5).replace(":", "");
  return `auto-${hhmm}`;
}

async function resolveResumePrompt(opts: AutoWorkflowOptions): Promise<string | undefined> {
  if (!opts.resume || opts.prompt) return opts.prompt;
  const handoffsDir = path.join(ccmuxDir(), "handoffs");
  try {
    const files = await fs.readdir(handoffsDir);
    const matches = files.filter((f) => f.endsWith(`-${opts.resume}.md`)).sort();
    if (matches.length > 0) {
      const latest = path.join(handoffsDir, matches[matches.length - 1]);
      const content = await fs.readFile(latest, "utf-8");
      return `前セッション ${opts.resume} の続きです:\n\n${content}`;
    }
  } catch {
    // handoffs dir not found — proceed without resume prompt
  }
  return opts.prompt;
}

export async function autoSessionWorkflow(name?: string, opts: AutoWorkflowOptions = {}): Promise<AutoWorkflowResult> {
  const prompt = await resolveResumePrompt(opts);
  const sessionName = name ?? autoName();
  const cfg = await loadConfig();
  const projectKey = cfg.defaultProject;
  const project = cfg.projects[projectKey];

  if (!project) {
    throw new SessionWorkflowError(`defaultProject "${projectKey}" not found. Run: ccmux init`, 500, "DEFAULT_PROJECT_NOT_FOUND");
  }

  const { type: muxType } = getMuxInfo();

  try {
    await acquireLock(sessionName);
    const worktree = await createWorktree(sessionName, project.path, { worktreeBase: cfg.worktreeBase });
    const session = await createSession({
      name: sessionName,
      branch: worktree.branch,
      worktreePath: worktree.path,
      projectPath: project.path,
      zellijTab: `ccmux:${sessionName}`,
      project: projectKey,
      llmBackend: project.defaultLlm,
    });

    if (prompt) {
      await writeTaskState(worktree.path, {
        sessionName,
        goal: prompt.slice(0, 500),
        iteration: 0,
        maxIterations: opts.maxIter ?? (opts.loop ? 50 : 1),
        status: "running",
        completedSteps: [],
        nextSteps: [],
        lastUpdated: new Date().toISOString(),
      });
      await installSessionHooks(worktree.path, sessionName, opts.maxIter ?? (opts.loop ? 50 : 1));
    }

    await fs.mkdir(path.join(worktree.path, ".claude", "tools"), { recursive: true });
    const baseClaudeCmd = await resolveClaudeCmd(project.defaultLlm);

    const result: AutoWorkflowResult = {
      sessionName,
      session,
      worktree,
      mode: opts.loop ? "autonomous loop" : "autonomous",
      muxType,
      until: opts.until ?? "CCMUX_COMPLETE",
      maxIterations: opts.maxIter ?? (opts.loop ? 50 : 1),
      promptSent: false,
    };

    if (muxType !== "none") {
      const claudeCmd = `${baseClaudeCmd} --dangerously-skip-permissions`;
      await openSession(sessionName, worktree.path, claudeCmd);
      await updateSession(session.id, { status: "starting" });

      if (prompt) {
        const fullPrompt = opts.loop ? taskStateClaudioPreamble(sessionName) + prompt : prompt;
        await sendToTab(sessionName, fullPrompt);
        result.session = await updateSession(session.id, { status: "busy" });
        result.promptSent = true;
      } else {
        result.session = await updateSession(session.id, { status: "idle" });
      }
    } else if (prompt) {
      const logDir = path.join(ccmuxDir(), "logs");
      await fs.mkdir(logDir, { recursive: true });
      const logFile = path.join(logDir, `${sessionName}.log`);
      const env = buildClaudeEnv(project.defaultLlm, cfg, sessionName);

      if (opts.loop) {
        await spawnLoopDaemon({
          sessionName,
          prompt,
          worktreePath: worktree.path,
          logFile,
          env,
          maxIter: opts.maxIter ?? 50,
          until: opts.until ?? "CCMUX_COMPLETE",
          sandbox: opts.sandbox,
        });
      } else {
        const promptFile = path.join(worktree.path, "TASK_PROMPT.md");
        await fs.writeFile(promptFile, prompt, "utf-8");
        const { bin, args: launchArgs } = buildLaunchArgs(
          ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
          worktree.path,
          opts.sandbox,
        );
        const logHandle = await fs.open(logFile, "a");
        const child = spawn(bin, launchArgs, {
          cwd: worktree.path,
          detached: true,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
          env,
          shell: process.platform === "win32",
        });
        child.unref();
        await logHandle.close();
        result.session = await updateSession(session.id, { status: "busy", pid: child.pid });
      }

      result.logFile = logFile;
      result.promptSent = true;
    } else {
      result.session = await updateSession(session.id, { status: "idle" });
      result.manualCommand = `cd "${worktree.path}" && ${baseClaudeCmd} --dangerously-skip-permissions`;
    }

    return result;
  } catch (err: unknown) {
    await releaseLock(sessionName).catch(() => {});
    throw err;
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
  const promptFile = path.join(worktreePath, "TASK_PROMPT.md");
  const preamble = taskStateClaudioPreamble(sessionName);
  await fs.writeFile(promptFile, preamble + prompt, "utf-8");

  const loopScript = path.join(worktreePath, ".ccmux-loop.sh");
  const { bin: claudeBin, args: claudeSandboxArgs } = buildLaunchArgs(
    ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
    worktreePath,
    opts.sandbox,
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

function buildLaunchArgs(
  claudeArgs: string[],
  worktreePath: string,
  sandbox?: boolean,
): { bin: string; args: string[] } {
  if (!sandbox) return { bin: "claude", args: claudeArgs };

  return {
    bin: "bwrap",
    args: [
      "--unshare-pid",
      "--unshare-net",
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
    ],
  };
}
