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

  it("does not steal a freshly-created, not-yet-written lock (lock-steal race fix)", async () => {
    const lockPath = path.join(tmp, "sessions.json.lock");
    // Simulate a holder that created the lock via open("wx") but has not yet
    // written its {pid}: an EMPTY body with a fresh mtime. Reading "" must NOT
    // be taken as a dead holder, or two acquirers would run concurrently.
    await fs.writeFile(lockPath, "");

    const p = createSession(sessionOpts("waits-for-holder"));

    // After a grace period createSession is still waiting and has left the empty
    // lock untouched — a steal would have unlinked it and written a {pid} body.
    await new Promise((r) => setTimeout(r, 200));
    expect(await fs.readFile(lockPath, "utf-8")).toBe("");

    // The "holder" finishes; createSession then acquires and completes.
    await fs.rm(lockPath, { force: true });
    const s = await p;
    expect(s.name).toBe("waits-for-holder");
  });
});
