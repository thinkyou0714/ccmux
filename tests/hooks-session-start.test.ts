import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

// Exercises the real session-start.sh: it re-injects TASK_STATE.md to stderr
// only when the SessionStart source is "compact". The "source" field is parsed
// with node (not `grep -oP`, whose PCRE lookbehind is absent on macOS/BSD grep
// and busybox), so this also pins that portability fix. Bash-only (POSIX).
const posixOnly = process.platform === "win32" ? describe.skip : describe;

let tmp: string; // the worktree
let hookPath: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-ss-"));
  await installSessionHooks(tmp, "ss", 50);
  hookPath = path.join(tmp, ".claude", "hooks", "session-start.sh");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function run(stdin: string): { status: number; stderr: string } {
  const r = spawnSync("bash", [hookPath], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env },
  });
  return { status: r.status ?? 1, stderr: r.stderr ?? "" };
}

posixOnly("SessionStart hook — compaction recovery", () => {
  it("re-injects TASK_STATE.md when source is 'compact'", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "# TASK_STATE\n\nMARKER-RESTORE-ME\n");
    const { status, stderr } = run(JSON.stringify({ source: "compact", session_id: "abc" }));
    expect(status).toBe(0);
    expect(stderr).toContain("restoring session state");
    expect(stderr).toContain("MARKER-RESTORE-ME");
  });

  it("is a no-op when source is not 'compact' (e.g. startup)", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "# TASK_STATE\n\nMARKER-RESTORE-ME\n");
    const { status, stderr } = run(JSON.stringify({ source: "startup" }));
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("is a no-op on compact when TASK_STATE.md is absent", async () => {
    await fs.rm(path.join(tmp, "TASK_STATE.md"), { force: true });
    const { status, stderr } = run(JSON.stringify({ source: "compact" }));
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("tolerates malformed JSON stdin without failing the session", () => {
    const { status, stderr } = run("not json at all");
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("parses 'source' regardless of key order / extra fields", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "# TASK_STATE\n\nORDER-OK\n");
    const { status, stderr } = run(JSON.stringify({ session_id: "z", cwd: "/x", source: "compact" }));
    expect(status).toBe(0);
    expect(stderr).toContain("ORDER-OK");
  });
});

describe("SessionStart hook — POSIX worktree path", () => {
  it("embeds TASK_STATE_FILE with a POSIX worktree path", async () => {
    const script = await fs.readFile(hookPath, "utf-8");
    const taskStateLine = script
      .split("\n")
      .find((line) => line.startsWith("TASK_STATE_FILE="));

    expect(taskStateLine).toBeDefined();
    expect(taskStateLine).not.toContain("\\");
    expect(taskStateLine).toBe(
      `TASK_STATE_FILE="${tmp.replace(/\/g, "/")}/TASK_STATE.md"`,
    );
  });
});
