import fs from "fs/promises";
import path from "path";

export interface TaskState {
  sessionName: string;
  goal: string;
  iteration: number;
  maxIterations: number;
  status: "running" | "complete" | "failed";
  completedSteps: string[];
  nextSteps: string[];
  lastUpdated: string;
}

export async function writeTaskState(worktreePath: string, state: TaskState): Promise<void> {
  const file = path.join(worktreePath, "TASK_STATE.md");
  const lines = [
    `# TASK_STATE`,
    ``,
    `> This file is the single source of truth for long-running autonomous sessions.`,
    `> After any context compaction, re-read this file before taking any action.`,
    ``,
    `- **Session**: ${state.sessionName}`,
    `- **Status**: ${state.status}`,
    `- **Iteration**: ${state.iteration} / ${state.maxIterations}`,
    `- **Last Updated**: ${state.lastUpdated}`,
    ``,
    `## Goal`,
    ``,
    state.goal,
    ``,
    `## Completed Steps`,
    ``,
    ...(state.completedSteps.length > 0
      ? state.completedSteps.map((s) => `- [x] ${s}`)
      : ["_(none yet)_"]),
    ``,
    `## Next Steps`,
    ``,
    ...(state.nextSteps.length > 0
      ? state.nextSteps.map((s) => `- [ ] ${s}`)
      : ["_(none planned)_"]),
    ``,
  ];
  // I-085: atomic write. The loop daemon rewrites this file every iteration and
  // it is the agent's single source of truth, so a crash mid-write must not
  // leave a truncated/corrupt TASK_STATE.md. Write to a sibling tmp file,
  // fsync it to disk, then rename() it into place — rename is atomic on POSIX
  // (and replaces atomically on Windows), so a reader sees either the old file
  // or the fully-written new one, never a partial.
  const tmp = path.join(
    worktreePath,
    `.TASK_STATE.md.tmp-${process.pid}-${Date.now().toString(36)}`
  );
  const data = lines.join("\n");
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(data, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, file);
  } catch (err) {
    // Best-effort cleanup of the tmp file so a failed write doesn't litter the
    // worktree. Ignore errors here (e.g. handle already closed / tmp absent);
    // the original write error is what matters.
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readTaskState(worktreePath: string): Promise<TaskState | undefined> {
  const file = path.join(worktreePath, "TASK_STATE.md");
  try {
    const content = await fs.readFile(file, "utf-8");
    return parseTaskState(content);
  } catch {
    return undefined;
  }
}

/**
 * Parse the TASK_STATE.md serialisation produced by {@link writeTaskState}.
 *
 * I-086: robust against corrupt/partial input. Rather than returning plausible
 * but wrong data (e.g. a `slice(start+2)` when `## Goal` is absent, which silently
 * grabbed the wrong lines), this throws on any input that doesn't have the
 * required structure. {@link readTaskState} catches the throw and returns
 * `undefined`, which callers already treat as "no valid state" — failing safe
 * instead of acting on garbage. The on-disk format is unchanged; this only
 * hardens the read path (hooks.ts's bash regexes are unaffected).
 */
function parseTaskState(content: string): TaskState {
  const lines = content.split("\n");

  // Required marker — without it this isn't a TASK_STATE document at all.
  if (!lines.some((l) => l.trim() === "# TASK_STATE")) {
    throw new Error("TASK_STATE.md: missing '# TASK_STATE' header");
  }

  /** Read a required `- **Key**: value` field; throw if absent. */
  const getRequired = (prefix: string): string => {
    const line = lines.find((l) => l.startsWith(`- **${prefix}**:`));
    if (line === undefined) {
      throw new Error(`TASK_STATE.md: missing required field '**${prefix}**'`);
    }
    return line.replace(new RegExp(`^- \\*\\*${prefix}\\*\\*:\\s*`), "").trim();
  };

  const iterStr = getRequired("Iteration");
  const [iterCurRaw, iterMaxRaw] = iterStr.split("/").map((s) => s.trim());
  const iterCur = Number.parseInt(iterCurRaw ?? "", 10);
  const iterMax = Number.parseInt(iterMaxRaw ?? "", 10);
  // A non-numeric iteration means the file is corrupt; don't silently default
  // to 0/50 and let the loop daemon mis-count.
  if (Number.isNaN(iterCur) || Number.isNaN(iterMax)) {
    throw new Error(`TASK_STATE.md: non-numeric Iteration '${iterStr}'`);
  }

  const statusRaw = getRequired("Status");
  if (statusRaw !== "running" && statusRaw !== "complete" && statusRaw !== "failed") {
    throw new Error(`TASK_STATE.md: invalid Status '${statusRaw}'`);
  }
  const status: TaskState["status"] = statusRaw;

  const section = (header: string): string[] => {
    const start = lines.findIndex((l) => l.trim() === `## ${header}`);
    if (start === -1) {
      throw new Error(`TASK_STATE.md: missing required section '## ${header}'`);
    }
    const end = lines.findIndex((l, i) => i > start + 1 && l.startsWith("## "));
    const slice = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end);
    return slice
      .filter((l) => l.startsWith("- [x] ") || l.startsWith("- [ ] "))
      .map((l) => l.replace(/^- \[.\] /, "").trim());
  };

  const goalStart = lines.findIndex((l) => l.trim() === "## Goal");
  if (goalStart === -1) {
    throw new Error("TASK_STATE.md: missing required section '## Goal'");
  }
  const goalEnd = lines.findIndex((l, i) => i > goalStart + 1 && l.startsWith("## "));
  const goalLines = goalEnd === -1 ? lines.slice(goalStart + 2) : lines.slice(goalStart + 2, goalEnd);
  const goal = goalLines.filter((l) => l.trim() && !l.startsWith("#")).join("\n").trim();

  // section() throws if either steps section is absent, keeping the required-
  // structure contract symmetric for Goal / Completed Steps / Next Steps.
  const completedSteps = section("Completed Steps");
  const nextSteps = section("Next Steps");

  return {
    sessionName: getRequired("Session"),
    goal,
    iteration: iterCur,
    maxIterations: iterMax,
    status,
    completedSteps,
    nextSteps,
    lastUpdated: getRequired("Last Updated"),
  };
}

/** Build the CLAUDE.md preamble that instructs the agent to manage TASK_STATE.md. */
export function taskStateClaudioPreamble(sessionName: string): string {
  return [
    `## Autonomous Session Instructions (ccmux)`,
    ``,
    `You are running as a long-lived autonomous agent in session **${sessionName}**.`,
    ``,
    `### Persistent Memory`,
    `**CRITICAL**: TASK_STATE.md in this worktree is your persistent memory. You MUST:`,
    `1. Re-read TASK_STATE.md at the start of EVERY response, especially after context compaction.`,
    `2. Update TASK_STATE.md whenever you complete a step or identify new next steps.`,
    `3. Set status to "complete" in TASK_STATE.md when the goal is fully achieved.`,
    `4. Commit progress to git every ~30 minutes with message prefix: \`[checkpoint]\`.`,
    ``,
    `### Context Compaction Recovery`,
    `If you notice your context has been compacted (session restarted, earlier conversation missing):`,
    `1. Immediately read TASK_STATE.md — it is your source of truth.`,
    `2. Read any \`.claude/tools/\` scripts that were created in this session.`,
    `3. Run \`git log --oneline -10\` to see recent checkpoints.`,
    `4. Continue from "Next Steps" in TASK_STATE.md without asking.`,
    ``,
    `When you use /compact, use this structured format to preserve critical context:`,
    `\`/compact [COMPACT #N | NEXT: <one sentence> | DECISIONS: <key choices> | DEAD_ENDS: <what failed> | TASK_STATE: see TASK_STATE.md]\``,
    ``,
    `### Self-Improving Tool Synthesis`,
    `If you find yourself repeating the same analysis or transformation pattern more than twice:`,
    `1. Create a reusable script in \`.claude/tools/<name>.sh\` (or .py).`,
    `2. Make it executable: \`chmod +x .claude/tools/<name>.sh\``,
    `3. Use it in subsequent steps — accumulated tools persist across loop iterations.`,
    `4. Document the tool's purpose in the first line comment.`,
    ``,
    `### Completion Signal`,
    `When the task is fully complete:`,
    `1. Set \`status: complete\` in TASK_STATE.md`,
    `2. Output the literal text: \`CCMUX_COMPLETE\``,
    ``,
  ].join("\n");
}
