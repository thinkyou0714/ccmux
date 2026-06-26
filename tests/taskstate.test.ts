import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { writeTaskState, readTaskState, type TaskState } from "../src/core/taskstate.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-taskstate-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const base: TaskState = {
  sessionName: "demo",
  goal: "Ship the thing\nwith two lines",
  iteration: 3,
  maxIterations: 50,
  status: "running",
  completedSteps: ["did A", "did B"],
  nextSteps: ["do C"],
  lastUpdated: "2026-06-26T00:00:00.000Z",
};

describe("taskstate round-trip", () => {
  it("write → read preserves every field", async () => {
    await writeTaskState(tmp, base);
    const got = await readTaskState(tmp);
    expect(got).toEqual(base);
  });

  it("round-trips empty step lists", async () => {
    const empty: TaskState = { ...base, completedSteps: [], nextSteps: [] };
    await writeTaskState(tmp, empty);
    const got = await readTaskState(tmp);
    // "_(none yet)_" / "_(none planned)_" placeholders are NOT checkbox lines,
    // so they parse back to empty arrays.
    expect(got?.completedSteps).toEqual([]);
    expect(got?.nextSteps).toEqual([]);
  });

  it("round-trips each terminal status", async () => {
    for (const status of ["running", "complete", "failed"] as const) {
      await writeTaskState(tmp, { ...base, status });
      expect((await readTaskState(tmp))?.status).toBe(status);
    }
  });
});

describe("taskstate parser robustness", () => {
  it("returns undefined when the file does not exist", async () => {
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("coerces an unknown Status back to 'running' (no smuggled enum)", async () => {
    await fs.writeFile(
      path.join(tmp, "TASK_STATE.md"),
      ["# TASK_STATE", "", "- **Status**: bogus", "## Goal", "", "g", ""].join("\n"),
      "utf-8",
    );
    expect((await readTaskState(tmp))?.status).toBe("running");
  });

  it("defaults a malformed iteration line to 0 / 50", async () => {
    await fs.writeFile(
      path.join(tmp, "TASK_STATE.md"),
      ["# TASK_STATE", "", "- **Iteration**: not/a/number", "## Goal", "", "g", ""].join("\n"),
      "utf-8",
    );
    const got = await readTaskState(tmp);
    expect(got?.iteration).toBe(0);
    expect(got?.maxIterations).toBe(50);
  });

  it("treats missing step sections as empty", async () => {
    await fs.writeFile(
      path.join(tmp, "TASK_STATE.md"),
      ["# TASK_STATE", "", "- **Session**: x", "## Goal", "", "g", ""].join("\n"),
      "utf-8",
    );
    const got = await readTaskState(tmp);
    expect(got?.completedSteps).toEqual([]);
    expect(got?.nextSteps).toEqual([]);
  });
});
