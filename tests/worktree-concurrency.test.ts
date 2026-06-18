import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { createWorktree, deleteWorktree, listWorktrees } from "../src/core/worktree.js";

// I-093: cross-process serialization of worktree mutations + a startup
// reconciler. These tests drive the *real* git CLI against a throwaway repo and
// confirm that (a) concurrent createWorktree calls on one repo all succeed
// without corrupting `.git/worktrees`, and (b) a registration whose directory
// vanished is pruned automatically so a same-name re-add succeeds.

let tmp: string;
let repo: string;
let worktreeBase: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wt-conc-"));
  repo = path.join(tmp, "repo");
  worktreeBase = path.join(tmp, "worktrees");
  await fs.mkdir(repo, { recursive: true });

  // Isolate the lock directory (~/.ccmux/locks) into the temp dir so the
  // per-repo worktree lock can't collide with the real machine or other suites.
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  process.env.HOME = tmp;

  await execa("git", ["-C", repo, "init"], { stdio: "pipe" });
  await fs.writeFile(path.join(repo, "tracked.txt"), "initial\n");
  await execa("git", ["-C", repo, "add", "tracked.txt"], { stdio: "pipe" });
  await execa(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=ccmux-test",
      "-c",
      "user.email=ccmux-test@example.com",
      // Disable commit signing: CI/dev machines may have commit.gpgsign=true
      // globally, which would fail this throwaway test commit.
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    ],
    { stdio: "pipe" },
  );
});

afterEach(async () => {
  process.env = { ...origEnv };
  await Promise.race([
    fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
});

describe("createWorktree — concurrent serialization (I-093)", () => {
  it("creates three worktrees concurrently without corrupting the registry", async () => {
    const names = ["feat-a", "feat-b", "feat-c"];

    // Fire all three at once. Without per-repo serialization, the racing
    // `git worktree add` calls clobber `.git/worktrees` and at least one fails
    // or registers a broken entry. The lock must make all three succeed.
    const results = await Promise.all(
      names.map((n) => createWorktree(n, repo, { worktreeBase })),
    );

    expect(results.map((r) => r.name).sort()).toEqual([...names].sort());

    const list = await listWorktrees(repo);
    expect(list.map((w) => w.name).sort()).toEqual([...names].sort());

    // Every reported worktree path must actually exist on disk and be a real
    // checkout (proves no half-written registration).
    for (const wt of list) {
      const st = await fs.stat(path.join(wt.path, "tracked.txt"));
      expect(st.isFile()).toBe(true);
    }

    // The lock file must not be left behind once all operations finished.
    const locksDir = path.join(process.env.CCMUX_DIR!, "locks");
    const leftover = await fs.readdir(locksDir).catch(() => [] as string[]);
    expect(leftover.filter((f) => f.startsWith("worktree-"))).toEqual([]);
  }, 30000);

  it("interleaves concurrent create and delete on the same repo without wedging", async () => {
    // Seed one worktree, then concurrently delete it while adding two others.
    await createWorktree("seed", repo, { worktreeBase });

    const ops: Promise<unknown>[] = [
      deleteWorktree("seed", repo, { worktreeBase, force: true }),
      createWorktree("extra-1", repo, { worktreeBase }),
      createWorktree("extra-2", repo, { worktreeBase }),
    ];

    await Promise.all(ops);

    const list = await listWorktrees(repo);
    expect(list.map((w) => w.name).sort()).toEqual(["extra-1", "extra-2"]);
  }, 30000);
});

describe("createWorktree — startup reconciler (I-093)", () => {
  it("prunes a stale registration whose directory vanished, then re-adds the same name", async () => {
    const name = "ghost";
    const first = await createWorktree(name, repo, { worktreeBase });

    // Simulate a crash that removed the worktree directory but left the
    // `.git/worktrees/<name>` registration behind (a "ghost"). A naive re-add
    // would fail with "already registered"/"already exists".
    await fs.rm(first.path, { recursive: true, force: true });

    // Sanity: git still believes the worktree exists (registration is stale).
    const { stdout } = await execa(
      "git",
      ["-C", repo, "worktree", "list", "--porcelain"],
      { stdio: "pipe" },
    );
    expect(stdout).toContain(`ccmux/${name}`);

    // The reconciler (git worktree prune at the top of createWorktree) must
    // clear the ghost so this same-name re-creation succeeds.
    const second = await createWorktree(name, repo, { worktreeBase });
    expect(second.name).toBe(name);
    expect(await fs.realpath(second.path)).toBe(await fs.realpath(first.path));

    const list = await listWorktrees(repo);
    expect(list.map((w) => w.name)).toEqual([name]);
    const st = await fs.stat(path.join(second.path, "tracked.txt"));
    expect(st.isFile()).toBe(true);
  }, 30000);
});
