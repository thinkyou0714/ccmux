import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";

let tmp: string;
let repo: string;
let worktreeBase: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-close-force-"));
  repo = path.join(tmp, "repo");
  worktreeBase = path.join(tmp, "worktrees");
  await fs.mkdir(repo, { recursive: true });

  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  process.env.HOME = tmp;
  delete process.env.ZELLIJ_SESSION_NAME;
  delete process.env.TMUX;

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
      "commit",
      "-m",
      "initial",
    ],
    { stdio: "pipe" }
  );

  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.CCMUX_DIR, "config.json"),
    JSON.stringify(
      {
        version: 1,
        worktreeBase,
        obsidian: { enabled: false },
        cost: { enabled: false, currency: "USD", exchangeRate: 1 },
      },
      null,
      2
    )
  );
});

afterEach(async () => {
  process.env = { ...origEnv };
  // Best-effort temp cleanup. On Windows git can keep a handle on the temp repo,
  // so cap teardown time and swallow errors — it must never hang or fail the suite.
  await Promise.race([
    fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
});

describe("closeCommand --force", () => {
  it("removes an uncommitted worktree and marks the session closed", async () => {
    const name = "dirty-close";
    const { createWorktree } = await import("../src/core/worktree.js");
    const { createSession, getSession } = await import("../src/core/session.js");
    const { closeCommand } = await import("../src/commands/close.js");

    const wt = await createWorktree(name, repo, { worktreeBase });
    await createSession({
      name,
      branch: wt.branch,
      worktreePath: wt.path,
      projectPath: repo,
      zellijTab: `ccmux:${name}`,
      pid: undefined,
      project: "test",
      llmBackend: "claude",
    });

    await fs.writeFile(path.join(wt.path, "tracked.txt"), "dirty\n");

    await closeCommand(name, { force: true, handoff: false, dashboard: false });

    await expect(fs.access(wt.path)).rejects.toThrow();
    const session = await getSession(name);
    expect(session?.status).toBe("closed");
  });
});
