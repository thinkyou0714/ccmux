import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { listSessions, createSession } from "../src/core/session.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-session-corrupt-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

async function corruptBackups(): Promise<string[]> {
  const files = await fs.readdir(tmp);
  return files.filter((f) => f.startsWith("sessions.json.corrupt-"));
}

const seed = {
  branch: "ccmux/x",
  worktreePath: "/tmp/x",
  projectPath: "/tmp",
  zellijTab: "ccmux:x",
  project: "test",
  llmBackend: "claude" as const,
};

describe("readDB corrupt sessions.json handling", () => {
  it("returns an empty list for a missing file without creating a backup", async () => {
    expect(await listSessions()).toEqual([]);
    expect(await corruptBackups()).toEqual([]);
  });

  it("backs up a syntactically corrupt sessions.json before returning empty", async () => {
    const corrupt = "{ this is not valid json ";
    await fs.writeFile(path.join(tmp, "sessions.json"), corrupt);

    expect(await listSessions()).toEqual([]);

    const backups = await corruptBackups();
    expect(backups).toHaveLength(1);
    // The backup preserves the original bytes for recovery.
    expect(await fs.readFile(path.join(tmp, backups[0]), "utf-8")).toBe(corrupt);
  });

  it("backs up a structurally invalid DB (missing sessions array)", async () => {
    await fs.writeFile(path.join(tmp, "sessions.json"), JSON.stringify({ version: 1 }));
    expect(await listSessions()).toEqual([]);
    expect(await corruptBackups()).toHaveLength(1);
  });

  it("preserves corrupt data even when the next write starts a fresh DB", async () => {
    await fs.writeFile(path.join(tmp, "sessions.json"), "GARBAGE");

    // A write after a corrupt read starts fresh; the original must survive.
    await createSession({ name: "fresh", ...seed });

    const backups = await corruptBackups();
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, backups[0]), "utf-8")).toBe("GARBAGE");
    expect((await listSessions()).map((s) => s.name)).toContain("fresh");
  });

  it("reads a valid sessions.json normally (no backup)", async () => {
    await createSession({ name: "ok", ...seed });
    expect((await listSessions()).map((s) => s.name)).toContain("ok");
    expect(await corruptBackups()).toEqual([]);
  });
});
