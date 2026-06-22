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

  it("reclaims a sessions lock held by a dead PID instead of waiting out the TTL (F-03)", async () => {
    // A pid no process can hold → process.kill(pid, 0) throws ESRCH (dead holder).
    const deadPid = 1 << 30;

    // Pre-create the lock with the dead holder and a FRESH mtime, so the 30s
    // mtime TTL alone would force a ~30s wait — only PID liveness reclaims it now.
    const lockPath = path.join(tmp, "sessions.json.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }),
    );

    const t0 = Date.now();
    const s = await createSession(sessionOpts("after-dead-lock"));
    expect(Date.now() - t0).toBeLessThan(3000); // reclaimed promptly, not after ~30s
    expect(s.name).toBe("after-dead-lock");
  });
});
