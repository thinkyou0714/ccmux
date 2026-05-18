import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createSession, listSessions, type Session } from "../src/core/session.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-session-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

function sessionOpts(name: string): Omit<Session, "id" | "createdAt" | "updatedAt" | "costUSD" | "status"> {
  return {
    name,
    branch: `ccmux/${name}`,
    worktreePath: path.join(tmp, name),
    projectPath: tmp,
    zellijTab: `ccmux:${name}`,
    project: "test",
    llmBackend: "claude",
  };
}

describe("session persistence locking", () => {
  it("preserves every concurrent createSession", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `session-${i}`);

    const created = await Promise.all(
      names.map((name) => createSession(sessionOpts(name)))
    );

    const sessions = await listSessions({ includeClosed: true });
    expect(sessions).toHaveLength(names.length);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(names.length);
    expect(sessions.map((s) => s.name).sort()).toEqual(names.sort());
    expect(created.map((s) => s.name).sort()).toEqual(names.sort());
  });
});
