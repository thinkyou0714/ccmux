import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

let tmp: string;
let hookPath: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-ss-"));
  await installSessionHooks(tmp, "ss-test", 50);
  hookPath = path.join(tmp, ".claude", "hooks", "session-start.sh");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("SessionStart hook", () => {
  it("embeds TASK_STATE_FILE with a POSIX worktree path", async () => {
    const script = await fs.readFile(hookPath, "utf-8");
    const taskStateLine = script
      .split("\n")
      .find((line) => line.startsWith("TASK_STATE_FILE="));

    expect(taskStateLine).toBeDefined();
    expect(taskStateLine).not.toContain("\\");
    expect(taskStateLine).toBe(
      `TASK_STATE_FILE="${tmp.replace(/\\/g, "/")}/TASK_STATE.md"`,
    );
  });
});
