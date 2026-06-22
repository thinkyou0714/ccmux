import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { createWorktree, listWorktrees } from "../src/core/worktree.js";

let tmp: string;
let repo: string;
let worktreeBase: string;

async function git(...args: string[]): Promise<void> {
  await execa(
    "git",
    ["-C", repo, "-c", "user.name=ccmux-test", "-c", "user.email=ccmux-test@example.com", ...args],
    { stdio: "pipe" },
  );
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wt-list-"));
  repo = path.join(tmp, "repo");
  worktreeBase = path.join(tmp, "worktrees");
  await fs.mkdir(repo, { recursive: true });

  await execa("git", ["-C", repo, "init"], { stdio: "pipe" });
  await fs.writeFile(path.join(repo, "tracked.txt"), "initial\n");
  await git("add", "tracked.txt");
  await git("commit", "-m", "initial");
});

afterEach(async () => {
  await Promise.race([
    fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
});

describe("listWorktrees (BUG-01: anchored prefix match)", () => {
  it("lists ccmux-managed worktrees and strips the prefix from the name", async () => {
    await createWorktree("feature-a", repo, { worktreeBase });
    const list = await listWorktrees(repo);

    // Match on the parsed branch ref, not the filesystem path: git reports the
    // realpath (e.g. macOS `/private/...`, Windows short/long forms) which never
    // equals the path we joined locally.
    const mine = list.find((w) => w.branch === "ccmux/feature-a");
    expect(mine).toBeDefined();
    expect(mine?.name).toBe("feature-a");
  });

  it("does NOT list a user branch that merely contains 'ccmux' as a substring", async () => {
    // The real ccmux worktree.
    await createWorktree("mine", repo, { worktreeBase });

    // A decoy worktree on a branch that contains "ccmux" but is not under
    // `refs/heads/ccmux/`. The old substring match would have claimed it.
    const decoyPath = path.join(tmp, "decoy");
    await git("worktree", "add", "-b", "feature/ccmux-notes", "--", decoyPath);

    const list = await listWorktrees(repo);
    const names = list.map((w) => w.name);
    const branches = list.map((w) => w.branch);

    expect(names).toContain("mine");
    expect(branches).toContain("ccmux/mine");

    // The decoy must not appear under any guise. listWorktrees derives name and
    // branch purely from the git ref, so a leaked decoy would surface here.
    expect(branches).not.toContain("feature/ccmux-notes");
    expect(names).not.toContain("feature/ccmux-notes");
    expect(names).not.toContain("ccmux-notes");
  });

  it("does NOT list a branch named with a 'ccmux' prefix but no slash (e.g. ccmux-wip)", async () => {
    await createWorktree("real", repo, { worktreeBase });

    const decoyPath = path.join(tmp, "ccmux-wip-wt");
    await git("worktree", "add", "-b", "ccmux-wip", "--", decoyPath);

    const list = await listWorktrees(repo);
    expect(list.map((w) => w.branch)).toContain("ccmux/real");
    expect(list.map((w) => w.branch)).not.toContain("ccmux-wip");
  });
});
