import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { createWorktree, listWorktrees } from "../src/core/worktree.js";

let tmp: string;
let repo: string;
let worktreeBase: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wt-list-"));
  repo = path.join(tmp, "repo");
  worktreeBase = path.join(tmp, "worktrees");
  await fs.mkdir(repo, { recursive: true });

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

describe("listWorktrees (I-088 — NUL/-z porcelain parsing)", () => {
  it("returns exactly the ccmux worktree it created", async () => {
    const name = "feature-x";
    const wt = await createWorktree(name, repo, { worktreeBase });

    const list = await listWorktrees(repo);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe(name);
    expect(list[0]?.branch).toBe(`ccmux/${name}`);
    // realpath both sides: git reports the canonical path, but the temp dir is a
    // symlink on macOS (/var -> /private/var) and uses different separators on
    // Windows, so a raw string compare is platform-fragile.
    expect(await fs.realpath(list[0]!.path)).toBe(await fs.realpath(wt.path));
    expect(list[0]?.projectPath).toBe(repo);
  });

  it("tolerates a worktree path containing a space (NUL split, not \\n\\n)", async () => {
    // Branch names can't contain spaces, so build a valid `ccmux/<name>` branch
    // checked out at a directory whose name DOES contain a space. The old
    // `\n\n`-based splitter was fragile around such paths; the NUL parser must
    // still extract the worktree and keep the branch filter aligned.
    const branch = "ccmux/spaced";
    const spacedPath = path.join(worktreeBase, "dir with space");
    await fs.mkdir(worktreeBase, { recursive: true });
    await execa("git", ["-C", repo, "worktree", "add", "-b", branch, spacedPath], {
      stdio: "pipe",
    });

    const list = await listWorktrees(repo);
    expect(list).toHaveLength(1);
    expect(list[0]?.branch).toBe(branch);
    expect(list[0]?.name).toBe("spaced");
    expect(await fs.realpath(list[0]!.path)).toBe(await fs.realpath(spacedPath));
  });

  it("ignores the main worktree and detached/non-ccmux worktrees", async () => {
    // A plain (non-ccmux) worktree on a detached HEAD must be filtered out — it
    // has no `branch ccmux/...` line, and the parser must not choke on the
    // missing branch attribute.
    const detachedPath = path.join(tmp, "detached");
    await execa("git", ["-C", repo, "worktree", "add", "--detach", detachedPath], {
      stdio: "pipe",
    });

    const list = await listWorktrees(repo);
    // Only ccmux/* worktrees are reported; none were created here.
    expect(list).toEqual([]);
  });
});
