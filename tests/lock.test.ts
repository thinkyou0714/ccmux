import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { acquireLock, releaseLock, isLocked, locksDir } from "../src/core/lock.js";

// I-049: dedicated coverage for core/lock.ts. The corrupt/empty-lock takeover
// and "second acquire while holder is alive" cases already live in
// cost-lock-hardening.test.ts; this file fills the remaining gaps — stale
// dead-PID takeover, releaseLock idempotency, isLocked truthiness, and the
// concurrent-acquire race — without duplicating those.

// A PID that is essentially guaranteed to be dead: just under PID_MAX on Linux
// and far above any realistic live PID, so process.kill(pid, 0) yields ESRCH and
// acquireLock takes the lock over. (Same value the project uses elsewhere for
// "definitely not running".)
const DEAD_PID = 2147483646;

const origEnv = { ...process.env };
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-lock-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("acquireLock — stale-lock recovery (I-049)", () => {
  it("takes over a lock held by a dead PID instead of blocking forever", async () => {
    await fs.mkdir(locksDir(), { recursive: true });
    const lp = path.join(locksDir(), "stale.lock");
    await fs.writeFile(lp, String(DEAD_PID));

    await expect(acquireLock("stale")).resolves.toBeUndefined();
    // The stale PID must have been replaced with our own (proves a real retake,
    // not a silent no-op that leaves the dead PID in place).
    expect((await fs.readFile(lp, "utf-8")).trim()).toBe(String(process.pid));

    await releaseLock("stale");
  });
});

describe("releaseLock — idempotency (I-049)", () => {
  it("does not throw when the lock file is absent", async () => {
    await expect(releaseLock("never-created")).resolves.toBeUndefined();
  });

  it("does not throw when called twice for the same lock", async () => {
    await acquireLock("twice");
    await expect(releaseLock("twice")).resolves.toBeUndefined();
    await expect(releaseLock("twice")).resolves.toBeUndefined();
  });
});

describe("isLocked (I-049)", () => {
  it("is false before acquire, true while held, false after release", async () => {
    expect(await isLocked("probe")).toBe(false);
    await acquireLock("probe");
    expect(await isLocked("probe")).toBe(true);
    await releaseLock("probe");
    expect(await isLocked("probe")).toBe(false);
  });
});

describe("acquireLock — concurrency (I-049)", () => {
  it("serializes a burst of same-name acquires to exactly one winner", async () => {
    // Exclusive `wx` create means exactly one of the concurrent writers wins; the
    // losers read back the winner's (live, == this process) PID and reject with
    // "already running". So: 1 fulfilled, N-1 rejected — never two holders.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireLock("race")),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      expect(msg).toMatch(/already running/i);
    }
    expect(await isLocked("race")).toBe(true);

    await releaseLock("race");
  });
});
