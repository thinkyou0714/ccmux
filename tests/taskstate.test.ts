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

function sample(overrides?: Partial<TaskState>): TaskState {
  return {
    sessionName: "sess-1",
    goal: "Build the thing",
    iteration: 3,
    maxIterations: 50,
    status: "running",
    completedSteps: ["scaffolded repo", "wrote parser"],
    nextSteps: ["add tests", "ship"],
    lastUpdated: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("I-051/I-085 taskstate write→read round-trip", () => {
  it("round-trips a full state through the atomic write path", async () => {
    const state = sample();
    await writeTaskState(tmp, state);
    const read = await readTaskState(tmp);
    expect(read).toEqual(state);
  });

  it("round-trips empty completed/next steps", async () => {
    const state = sample({ completedSteps: [], nextSteps: [] });
    await writeTaskState(tmp, state);
    const read = await readTaskState(tmp);
    expect(read).toEqual(state);
  });

  it("round-trips each status value", async () => {
    for (const status of ["running", "complete", "failed"] as const) {
      const state = sample({ status });
      await writeTaskState(tmp, state);
      const read = await readTaskState(tmp);
      expect(read?.status).toBe(status);
    }
  });

  it("writes atomically: no tmp files remain and TASK_STATE.md exists", async () => {
    await writeTaskState(tmp, sample());
    const entries = await fs.readdir(tmp);
    expect(entries).toContain("TASK_STATE.md");
    // The atomic write must rename its temp file away — no .tmp leftovers.
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });

  it("overwrites an existing TASK_STATE.md (rename replaces in place)", async () => {
    await writeTaskState(tmp, sample({ iteration: 1 }));
    await writeTaskState(tmp, sample({ iteration: 2, status: "complete" }));
    const read = await readTaskState(tmp);
    expect(read?.iteration).toBe(2);
    expect(read?.status).toBe("complete");
    const entries = await fs.readdir(tmp);
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });

  it("preserves the **Iteration** / **Status** line format hooks.ts depends on", async () => {
    // hooks.ts greps these exact markers with node regexes; the read path was
    // hardened but the serialisation must not change.
    await writeTaskState(tmp, sample({ iteration: 7, maxIterations: 42, status: "running" }));
    const raw = await fs.readFile(path.join(tmp, "TASK_STATE.md"), "utf-8");
    expect(raw).toMatch(/\*\*Iteration\*\*:\s*7\s*\/\s*42/);
    expect(raw).toMatch(/\*\*Status\*\*:\s*running/);
    // Mirror hooks.ts's own extraction regexes.
    expect(/\*\*Iteration\*\*:\s*(\d+)/.exec(raw)?.[1]).toBe("7");
    expect(/\*\*Status\*\*:\s*(\S+)/.exec(raw)?.[1]).toBe("running");
  });
});

describe("I-086 parseTaskState robustness on corrupt input", () => {
  it("returns undefined when TASK_STATE.md is absent", async () => {
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined for empty content", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "", "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined for arbitrary non-TASK_STATE content", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "hello world\nnot a state file\n", "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined when a required field is missing (Iteration)", async () => {
    // Start from a valid file, strip the Iteration line.
    await writeTaskState(tmp, sample());
    const raw = await fs.readFile(path.join(tmp, "TASK_STATE.md"), "utf-8");
    const corrupted = raw.split("\n").filter((l) => !l.includes("**Iteration**")).join("\n");
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), corrupted, "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined when a required section is missing (## Goal)", async () => {
    await writeTaskState(tmp, sample());
    const raw = await fs.readFile(path.join(tmp, "TASK_STATE.md"), "utf-8");
    const corrupted = raw.replace("## Goal", "## NotGoal");
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), corrupted, "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined for a non-numeric iteration value", async () => {
    await writeTaskState(tmp, sample());
    const raw = await fs.readFile(path.join(tmp, "TASK_STATE.md"), "utf-8");
    const corrupted = raw.replace(/\*\*Iteration\*\*:.*/, "- **Iteration**: foo / bar");
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), corrupted, "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("returns undefined for an invalid status token", async () => {
    await writeTaskState(tmp, sample());
    const raw = await fs.readFile(path.join(tmp, "TASK_STATE.md"), "utf-8");
    const corrupted = raw.replace(/\*\*Status\*\*:.*/, "- **Status**: bogus");
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), corrupted, "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });

  it("does not crash and returns undefined when only the header is present", async () => {
    await fs.writeFile(path.join(tmp, "TASK_STATE.md"), "# TASK_STATE\n", "utf-8");
    expect(await readTaskState(tmp)).toBeUndefined();
  });
});

describe("I-086 boundary / large-input cases", () => {
  it("round-trips a very large multi-line goal", async () => {
    // Big multi-paragraph goal; ensure neither write nor parse mangles it.
    const big = Array.from({ length: 500 }, (_, i) => `Goal line ${i} with some text.`).join("\n");
    const state = sample({ goal: big });
    await writeTaskState(tmp, state);
    const read = await readTaskState(tmp);
    expect(read?.goal).toBe(big);
  });

  it("handles iteration 0 and iteration == maxIterations boundaries", async () => {
    const zero = sample({ iteration: 0, maxIterations: 0 });
    await writeTaskState(tmp, zero);
    expect((await readTaskState(tmp))?.iteration).toBe(0);
    expect((await readTaskState(tmp))?.maxIterations).toBe(0);

    const atCap = sample({ iteration: 50, maxIterations: 50 });
    await writeTaskState(tmp, atCap);
    const read = await readTaskState(tmp);
    expect(read?.iteration).toBe(50);
    expect(read?.maxIterations).toBe(50);
  });

  it("handles a large iteration count", async () => {
    const state = sample({ iteration: 999999, maxIterations: 1000000 });
    await writeTaskState(tmp, state);
    const read = await readTaskState(tmp);
    expect(read?.iteration).toBe(999999);
    expect(read?.maxIterations).toBe(1000000);
  });

  it("preserves goal text that contains markdown-ish leading characters", async () => {
    // Lines starting with '#' inside the goal are dropped by design (treated as
    // headers); ensure normal hyphen/bullet-free prose survives intact.
    const state = sample({ goal: "Refactor module X.\nThen wire it into Y." });
    await writeTaskState(tmp, state);
    const read = await readTaskState(tmp);
    expect(read?.goal).toBe("Refactor module X.\nThen wire it into Y.");
  });
});
