import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { localToday } from "../src/core/cost.js";
import { acquireLock, releaseLock, locksDir } from "../src/core/lock.js";

const origEnv = { ...process.env };
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-hard-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("localToday (I-036 — invalid TZ must not crash)", () => {
  it("returns YYYY-MM-DD for a valid zone", () => {
    process.env.CCMUX_TIMEZONE = "Asia/Tokyo";
    expect(localToday(new Date("2026-06-18T15:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to system zone (no throw) for an invalid zone", () => {
    process.env.CCMUX_TIMEZONE = "Not/AZone";
    expect(() => localToday()).not.toThrow();
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("acquireLock (I-013 — corrupt lock recovery)", () => {
  it("rejects a second acquire while the holder is alive", async () => {
    await acquireLock("alive");
    await expect(acquireLock("alive")).rejects.toThrow(/already running/i);
    await releaseLock("alive");
  });

  it("takes over a corrupt/non-numeric lock instead of blocking forever", async () => {
    await fs.mkdir(locksDir(), { recursive: true });
    await fs.writeFile(path.join(locksDir(), "corrupt.lock"), "not-a-pid");
    await expect(acquireLock("corrupt")).resolves.toBeUndefined();
    await releaseLock("corrupt");
  });

  it("takes over an empty lock file (crash mid-write)", async () => {
    await fs.mkdir(locksDir(), { recursive: true });
    await fs.writeFile(path.join(locksDir(), "empty.lock"), "");
    await expect(acquireLock("empty")).resolves.toBeUndefined();
    await releaseLock("empty");
  });
});
