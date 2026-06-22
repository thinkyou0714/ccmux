import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createSession, type Session } from "../src/core/session.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-atomic-"));
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("REL-05: sessions.json atomic write (fsync + rename)", () => {
  it("commits valid JSON and leaves no .tmp behind", async () => {
    await createSession(sessionOpts("s1"));
    const file = path.join(tmp, "sessions.json");

    expect(await exists(file)).toBe(true);
    expect(await exists(`${file}.tmp`)).toBe(false); // renamed away, not left

    const db = JSON.parse(await fs.readFile(file, "utf-8")) as { sessions: Session[] };
    expect(db.sessions.map((s) => s.name)).toContain("s1");
  });

  it("keeps the file mode at 0600 across rewrites (POSIX)", async () => {
    if (process.platform === "win32") return; // POSIX perm bits only
    await createSession(sessionOpts("s1"));
    await createSession(sessionOpts("s2")); // second write replaces via rename
    const file = path.join(tmp, "sessions.json");
    const { mode } = await fs.stat(file);
    expect(mode & 0o777).toBe(0o600);
  });
});
