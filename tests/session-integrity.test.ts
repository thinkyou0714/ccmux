import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createSession, getSession, listSessions, updateSession } from "../src/core/session.js";

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

describe("readDB (I-063 — Zod-validated ledger, not `as SessionsDB`)", () => {
  it("rejects + backs up a ledger whose sessions is not an array", async () => {
    const file = path.join(process.env.CCMUX_DIR!, "sessions.json");
    // Valid JSON, but `sessions` is the wrong type — must be treated as corrupt.
    await fs.writeFile(file, JSON.stringify({ version: 1, sessions: {} }));
    await expect(getSession("x")).rejects.toThrow(/corrupt/i);
    const entries = await fs.readdir(process.env.CCMUX_DIR!);
    expect(entries.some((e) => e.startsWith("sessions.json.corrupt."))).toBe(true);
  });

  it("rejects + backs up a ledger with an unknown status enum", async () => {
    const file = path.join(process.env.CCMUX_DIR!, "sessions.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "1",
            name: "n",
            branch: "ccmux/n",
            worktreePath: "/tmp/n",
            projectPath: "/repo",
            zellijTab: "ccmux:n",
            status: "not-a-real-status",
            createdAt: "t",
            updatedAt: "t",
            costUSD: 0,
            project: "p",
            llmBackend: "claude",
          },
        ],
      }),
    );
    await expect(getSession("n")).rejects.toThrow(/corrupt/i);
    const entries = await fs.readdir(process.env.CCMUX_DIR!);
    expect(entries.some((e) => e.startsWith("sessions.json.corrupt."))).toBe(true);
  });

  it("accepts a well-formed ledger", async () => {
    // Written via the real createSession path, then read back unchanged.
    await createSession({ name: "ok", ...base });
    const sessions = await listSessions({ includeClosed: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.name).toBe("ok");
  });
});

describe("writeDB (I-082 — durable write survives the fsync round-trip)", () => {
  it("keeps the write→read round-trip intact after the fsync changes", async () => {
    const created = await createSession({ name: "durable", ...base });
    // Mutate through updateSession (a second writeDB) to exercise the fsync path
    // more than once, then confirm the ledger reads back exactly.
    await updateSession(created.id, { status: "idle", pid: 4321 });

    const got = await getSession("durable");
    expect(got?.id).toBe(created.id);
    expect(got?.status).toBe("idle");
    expect(got?.pid).toBe(4321);

    // The on-disk file is non-empty, valid JSON (no torn/0-byte ledger).
    const raw = await fs.readFile(
      path.join(process.env.CCMUX_DIR!, "sessions.json"),
      "utf-8",
    );
    expect(raw.length).toBeGreaterThan(0);
    const parsed = JSON.parse(raw) as { sessions: { name: string }[] };
    expect(parsed.sessions.map((s) => s.name)).toEqual(["durable"]);
    // No leftover tmp file after a successful write.
    const entries = await fs.readdir(process.env.CCMUX_DIR!);
    expect(entries.some((e) => e === "sessions.json.tmp")).toBe(false);
  });
});
