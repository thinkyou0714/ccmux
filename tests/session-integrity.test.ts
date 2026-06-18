import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createSession, getSession } from "../src/core/session.js";

const origEnv = { ...process.env };
let tmp: string;

const base = {
  branch: "ccmux/x",
  worktreePath: "/tmp/x",
  projectPath: "/repo",
  zellijTab: "ccmux:x",
  project: "p",
  llmBackend: "claude" as const,
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-sess-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("createSession (I-035 — no duplicate live rows)", () => {
  it("rejects a second non-closed session with the same name", async () => {
    await createSession({ name: "dup", ...base });
    await expect(createSession({ name: "dup", ...base })).rejects.toThrow(/already exists/i);
  });
});

describe("readDB (I-034 — corrupt ledger is preserved, not silently emptied)", () => {
  it("returns undefined when no ledger exists yet (fresh install)", async () => {
    await expect(getSession("anything")).resolves.toBeUndefined();
  });

  it("throws and backs up a corrupt ledger instead of overwriting it", async () => {
    const file = path.join(process.env.CCMUX_DIR!, "sessions.json");
    await fs.writeFile(file, "{ this is not json");
    await expect(getSession("x")).rejects.toThrow(/corrupt/i);
    // a .corrupt.<ts> backup must have been written next to the ledger
    const entries = await fs.readdir(process.env.CCMUX_DIR!);
    expect(entries.some((e) => e.startsWith("sessions.json.corrupt."))).toBe(true);
  });
});
