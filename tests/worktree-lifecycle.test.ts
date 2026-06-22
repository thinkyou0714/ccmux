import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createWorktree, deleteWorktree, listWorktrees } from "../src/core/worktree.js";

// Regression coverage for SEC-03: createWorktree/deleteWorktree gained `--`
// option terminators (worktree add/remove, branch -d). This drives the real git
// commands end-to-end in a throwaway repo to prove the terminators didn't break
// the normal create→list→delete path.

let repo: string;
let base: string;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wt-repo-"));
  base = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wt-base-"));
  await execa("git", ["-C", repo, "init", "-b", "main"]);
  await execa("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  await execa("git", ["-C", repo, "config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "README.md"), "x\n");
  await execa("git", ["-C", repo, "add", "."]);
  await execa("git", ["-C", repo, "commit", "-m", "init"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(base, { recursive: true, force: true });
});

describe("SEC-03: worktree lifecycle works with git `--` option terminators", () => {
  it("creates then deletes a worktree + branch", async () => {
    const wt = await createWorktree("sec03-demo", repo, { worktreeBase: base });
    expect(wt.branch).toBe("ccmux/sec03-demo");
    expect(await exists(wt.path)).toBe(true);

    const created = await execa("git", ["-C", repo, "branch", "--list", "ccmux/sec03-demo"]);
    expect(created.stdout).toContain("ccmux/sec03-demo");
    expect((await listWorktrees(repo)).some((w) => w.name === "sec03-demo")).toBe(true);

    // Exercises `worktree remove --force --` and `branch -d --`.
    await deleteWorktree("sec03-demo", repo, { worktreeBase: base });
    expect(await exists(wt.path)).toBe(false);

    const deleted = await execa("git", ["-C", repo, "branch", "--list", "ccmux/sec03-demo"]);
    expect(deleted.stdout.trim()).toBe("");
  });
});
