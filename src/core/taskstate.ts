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
  await fs.writeFile(file, lines.join("\n"), "utf-8");
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

function parseTaskState(content: string): TaskState {
  const lines = content.split("\n");

  const get = (prefix: string): string =>
    (lines.find((l) => l.startsWith(`- **${prefix}**:`)) ?? "")
      .replace(new RegExp(`^- \\*\\*${prefix}\\*\\*:\\s*`), "")
      .trim();

  const iterStr = get("Iteration");
  const [iterCur, iterMax] = iterStr.split("/").map((s) => parseInt(s.trim(), 10));

  const section = (header: string): string[] => {
    const start = lines.findIndex((l) => l.trim() === `## ${header}`);
    if (start === -1) return [];
    const end = lines.findIndex((l, i) => i > start + 1 && l.startsWith("## "));
    const slice = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end);
    return slice
      .filter((l) => l.startsWith("- [x] ") || l.startsWith("- [ ] "))
      .map((l) => l.replace(/^- \[.\] /, "").trim());
  };

  const goalStart = lines.findIndex((l) => l.trim() === "## Goal");
  const goalEnd = lines.findIndex((l, i) => i > goalStart + 1 && l.startsWith("## "));
  const goalLines = goalEnd === -1 ? lines.slice(goalStart + 2) : lines.slice(goalStart + 2, goalEnd);
  const goal = goalLines.filter((l) => l.trim() && !l.startsWith("#")).join("\n").trim();

  return {
    sessionName: get("Session"),
    goal,
    iteration: isNaN(iterCur) ? 0 : iterCur,
    maxIterations: isNaN(iterMax) ? 50 : iterMax,
    status: parseStatus(get("Status")),
    completedSteps: section("Completed Steps"),
    nextSteps: section("Next Steps"),
    lastUpdated: get("Last Updated"),
  };
}

const VALID_STATUSES: ReadonlyArray<TaskState["status"]> = ["running", "complete", "failed"];

/** Coerce the parsed Status field to a known enum value. A hand-edited or
 *  corrupt TASK_STATE.md must not smuggle an arbitrary string into the typed
 *  field (the previous unchecked `as` cast did); unknown → "running". */
function parseStatus(raw: string): TaskState["status"] {
  return (VALID_STATUSES as readonly string[]).includes(raw)
    ? (raw as TaskState["status"])
    : "running";
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
