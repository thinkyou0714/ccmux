import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { claimSession, completeSession, releaseSession, _closeDbForTests } from "../src/core/queue.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-queue-"));
  process.env.CCMUX_DIR = tmp;
  delete process.env.CCMUX_QUEUE_DISABLED;
  _closeDbForTests();
});

afterEach(async () => {
  _closeDbForTests();
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("BL-6 SQLite dedup queue", () => {
  it("first claim wins, second claim is rejected with existing info", () => {
    const a = claimSession("issue-42", "github");
    expect(a.claimed).toBe(true);
    expect(a.existing).toBeUndefined();

    const b = claimSession("issue-42", "github");
    expect(b.claimed).toBe(false);
    expect(b.existing?.source).toBe("github");
    expect(typeof b.existing?.createdAt).toBe("string");
    expect(b.existing?.completedAt).toBeNull();
  });

  it("different keys do not conflict", () => {
    expect(claimSession("issue-1", "github").claimed).toBe(true);
    expect(claimSession("issue-2", "github").claimed).toBe(true);
    expect(claimSession("issue-1", "github").claimed).toBe(false);
    expect(claimSession("issue-2", "github").claimed).toBe(false);
  });

  it("completeSession marks completed_at, key stays claimed", () => {
    expect(claimSession("issue-7", "manual").claimed).toBe(true);
    completeSession("issue-7");
    const dup = claimSession("issue-7", "manual");
    expect(dup.claimed).toBe(false);
    expect(dup.existing?.completedAt).not.toBeNull();
  });

  it("releaseSession removes the row so re-trigger can claim", () => {
    expect(claimSession("issue-9", "github").claimed).toBe(true);
    releaseSession("issue-9");
    expect(claimSession("issue-9", "github").claimed).toBe(true);
  });

  it("CCMUX_QUEUE_DISABLED=1 makes every call a no-op winner", () => {
    process.env.CCMUX_QUEUE_DISABLED = "1";
    _closeDbForTests();
    expect(claimSession("issue-x", "any").claimed).toBe(true);
    expect(claimSession("issue-x", "any").claimed).toBe(true);
    expect(claimSession("issue-x", "any").claimed).toBe(true);
    // No DB file should be created when disabled — we never opened a connection
    // for these calls.
  });

  it("CCMUX_DIR swap between calls opens a different DB", async () => {
    expect(claimSession("issue-1", "github").claimed).toBe(true);

    const alt = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-queue-alt-"));
    process.env.CCMUX_DIR = alt;
    // First claim against the new dir succeeds — separate DB.
    expect(claimSession("issue-1", "github").claimed).toBe(true);
    // Close the connection on Windows before unlink (EBUSY otherwise).
    _closeDbForTests();
    await fs.rm(alt, { recursive: true, force: true });
  });

  it("PERF-01: reuses cached statements across a burst and rebuilds them after a DB swap", async () => {
    // Burst against one connection — every call reuses the cached statements.
    for (let i = 0; i < 25; i++) {
      expect(claimSession(`burst-${i}`, "github").claimed).toBe(true);
    }
    for (let i = 0; i < 25; i++) {
      completeSession(`burst-${i}`);
      expect(claimSession(`burst-${i}`, "github").existing?.completedAt).not.toBeNull();
    }
    for (let i = 0; i < 25; i++) {
      releaseSession(`burst-${i}`);
      expect(claimSession(`burst-${i}`, "github").claimed).toBe(true);
    }

    // Swap CCMUX_DIR → the connection reopens → statements cached against the
    // old handle must be rebuilt against the new one (no stale-statement errors).
    const alt = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-queue-perf-alt-"));
    process.env.CCMUX_DIR = alt;
    expect(claimSession("after-swap", "github").claimed).toBe(true);
    completeSession("after-swap");
    expect(claimSession("after-swap", "github").existing?.completedAt).not.toBeNull();
    _closeDbForTests();
    await fs.rm(alt, { recursive: true, force: true });
  });
});
