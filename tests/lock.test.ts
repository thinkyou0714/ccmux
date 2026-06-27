import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { acquireLock, releaseLock } from "../src/core/lock.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-lock-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
});

afterEach(async () => {
  await releaseLock("corrupt-lock").catch(() => {});
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("acquireLock corrupt lock recovery", () => {
  it.each([
    ["empty", ""],
    ["non-numeric", "not-a-pid"],
  ])("treats %s lock files as stale", async (_label, contents) => {
    const locks = path.join(process.env.CCMUX_DIR!, "locks");
    const lockFile = path.join(locks, "corrupt-lock.lock");
    await fs.mkdir(locks, { recursive: true });
    await fs.writeFile(lockFile, contents, { mode: 0o600 });

    await expect(acquireLock("corrupt-lock")).resolves.toBeUndefined();
    await expect(fs.readFile(lockFile, "utf-8")).resolves.toBe(String(process.pid));
  });
});
