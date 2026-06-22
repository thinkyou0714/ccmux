import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { createWorktree } from "../src/core/worktree.js";
import { pruneCommand } from "../src/commands/prune.js";

let tmp: string;
let repo: string;
let worktreeBase: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-prune-ux-"));
  repo = path.join(tmp, "repo");
  worktreeBase = path.join(tmp, "worktrees");
  await fs.mkdir(repo, { recursive: true });

  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  process.env.CCMUX_WORKTREE_BASE = worktreeBase;
  delete process.env.ZELLIJ_SESSION_NAME;
  delete process.env.TMUX;

  await execa("git", ["-C", repo, "init"], { stdio: "pipe" });
  await fs.writeFile(path.join(repo, "tracked.txt"), "initial\n");
  await execa("git", ["-C", repo, "add", "tracked.txt"], { stdio: "pipe" });
  await execa(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-m", "init"],
    { stdio: "pipe" },
  );

  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.CCMUX_DIR, "config.json"),
    JSON.stringify({
      version: 1,
      worktreeBase,
      obsidian: { enabled: false },
      cost: { enabled: false, currency: "USD", exchangeRate: 1 },
    }),
  );
});

afterEach(async () => {
  process.env = { ...origEnv };
  await Promise.race([
    fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
});

async function seedOrphan(name: string, wtPath: string): Promise<void> {
  const session = {
    id: `id-${name}`,
    name,
    branch: `ccmux/${name}`,
    worktreePath: wtPath,
    projectPath: repo,
    zellijTab: `ccmux:${name}`,
    status: "orphaned",
    pid: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    costUSD: 0,
    project: "test",
    llmBackend: "claude",
  };
  await fs.writeFile(
    path.join(process.env.CCMUX_DIR as string, "sessions.json"),
    JSON.stringify({ version: 1, sessions: [session] }),
  );
}

// pruneCommand prints its summary via console.log (vitest routes that
// separately from process.stdout.write); ora status lines go to stderr.
function captureConsole(): { get: () => string; restore: () => void } {
  let out = "";
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += args.map((a) => String(a)).join(" ") + "\n";
  });
  return { get: () => out, restore: () => spy.mockRestore() };
}

async function statusOf(name: string): Promise<string | undefined> {
  const raw = await fs.readFile(
    path.join(process.env.CCMUX_DIR as string, "sessions.json"),
    "utf-8",
  );
  const db = JSON.parse(raw) as { sessions: { name: string; status: string }[] };
  return db.sessions.find((s) => s.name === name)?.status;
}

describe("pruneCommand REL-06 — skipped-orphan summary", () => {
  it("surfaces an actionable summary when a dirty orphan is skipped without --force", async () => {
    const wt = await createWorktree("orphan-dirty", repo, { worktreeBase });
    // Leave uncommitted changes so the non-force delete guard trips.
    await fs.writeFile(path.join(wt.path, "tracked.txt"), "dirty\n");
    await seedOrphan("orphan-dirty", wt.path);

    const cap = captureConsole();
    try {
      await pruneCommand({});
    } finally {
      cap.restore();
    }

    const out = cap.get();
    expect(out).toMatch(/orphan\(s\) skipped/);
    expect(out).toContain("orphan-dirty");
    expect(out).toMatch(/--force/);
    // The skipped orphan is left intact (not marked closed) so its work survives.
    expect(await statusOf("orphan-dirty")).toBe("orphaned");
  });

  it("removes the orphan and prints no skip summary with --force", async () => {
    const wt = await createWorktree("orphan-forced", repo, { worktreeBase });
    await fs.writeFile(path.join(wt.path, "tracked.txt"), "dirty\n");
    await seedOrphan("orphan-forced", wt.path);

    const cap = captureConsole();
    try {
      await pruneCommand({ force: true });
    } finally {
      cap.restore();
    }

    expect(cap.get()).not.toMatch(/skipped/);
    // --force removes the worktree and marks the session closed.
    expect(await statusOf("orphan-forced")).toBe("closed");
    await expect(fs.access(wt.path)).rejects.toThrow();
  });
});
