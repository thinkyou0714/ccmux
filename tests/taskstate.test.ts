import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { readTaskState } from "../src/core/taskstate.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-taskstate-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("readTaskState", () => {
  it("returns an empty goal when TASK_STATE.md has no Goal section", async () => {
    await fs.writeFile(
      path.join(tmp, "TASK_STATE.md"),
      [
        "# TASK_STATE",
        "",
        "- **Session**: missing-goal",
        "- **Status**: running",
        "- **Iteration**: 2 / 5",
        "- **Last Updated**: now",
        "",
        "## Completed Steps",
        "",
        "- [x] started",
        "",
        "## Next Steps",
        "",
        "- [ ] continue",
        "",
      ].join("\n")
    );

    const state = await readTaskState(tmp);

    expect(state?.goal).toBe("");
    expect(state?.completedSteps).toEqual(["started"]);
    expect(state?.nextSteps).toEqual(["continue"]);
  });
});
