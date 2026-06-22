import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { acquireLock, releaseLock, locksDir } from "../src/core/lock.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-lock-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedLock(name: string, contents: string): Promise<string> {
  const dir = locksDir();
  await fs.mkdir(dir, { recursive: true });
  const lp = path.join(dir, `${name}.lock`);
  await fs.writeFile(lp, contents);
  return lp;
}

async function lockOwner(lp: string): Promise<string> {
  return (await fs.readFile(lp, "utf-8")).trim();
}

describe("acquireLock self-heal (corrupt / stale lock files)", () => {
  it("reclaims a lock file whose contents are not a number", async () => {
    const lp = await seedLock("corrupt", "not-a-pid\n");
    await expect(acquireLock("corrupt")).resolves.toBeUndefined();
    expect(await lockOwner(lp)).toBe(String(process.pid));
    await releaseLock("corrupt");
  });

  it("reclaims an empty lock file", async () => {
    const lp = await seedLock("empty", "");
    await expect(acquireLock("empty")).resolves.toBeUndefined();
    expect(await lockOwner(lp)).toBe(String(process.pid));
    await releaseLock("empty");
  });

  it("reclaims a lock file with a zero pid", async () => {
    const lp = await seedLock("zero", "0");
    await expect(acquireLock("zero")).resolves.toBeUndefined();
    expect(await lockOwner(lp)).toBe(String(process.pid));
    await releaseLock("zero");
  });

  it("reclaims (never signals) a lock file with a negative pid", async () => {
    // process.kill(-1, 0) would target a whole process group on POSIX — the
    // guard must reclaim for any pid <= 0 rather than ever calling kill.
    const lp = await seedLock("neg", "-1");
    await expect(acquireLock("neg")).resolves.toBeUndefined();
    expect(await lockOwner(lp)).toBe(String(process.pid));
    await releaseLock("neg");
  });

  it("refuses to steal a lock held by a live process", async () => {
    // Our own pid is, by definition, alive.
    await seedLock("live", String(process.pid));
    await expect(acquireLock("live")).rejects.toThrow(/already running/);
  });
});
