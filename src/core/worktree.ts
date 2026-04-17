import { execa } from "execa";
import path from "path";
import fs from "fs/promises";

export interface WorktreeInfo {
  name: string;
  branch: string;
  path: string;
  projectPath: string;
}

const WORKTREE_BASE = process.env.CCMUX_WORKTREE_BASE ?? `${process.env.HOME}/worktrees`;
const BRANCH_PREFIX = "ccmux";

export async function createWorktree(
  name: string,
  projectPath: string
): Promise<WorktreeInfo> {
  const branch = `${BRANCH_PREFIX}/${name}`;
  const wtPath = path.join(WORKTREE_BASE, name);

  await fs.mkdir(WORKTREE_BASE, { recursive: true });

  // Check if worktree already exists
  const existing = await listWorktrees(projectPath);
  if (existing.some((w) => w.name === name)) {
    throw new Error(`Worktree "${name}" already exists at ${wtPath}`);
  }

  // Create branch and worktree
  try {
    await execa("git", ["-C", projectPath, "worktree", "add", "-b", branch, wtPath], {
      stdio: "pipe",
    });
  } catch (err: unknown) {
    // Branch might already exist — try without -b
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      await execa("git", ["-C", projectPath, "worktree", "add", wtPath, branch], {
        stdio: "pipe",
      });
    } else {
      throw err;
    }
  }

  return { name, branch, path: wtPath, projectPath };
}

export async function deleteWorktree(
  name: string,
  projectPath: string
): Promise<void> {
  const wtPath = path.join(WORKTREE_BASE, name);
  const branch = `${BRANCH_PREFIX}/${name}`;

  // Check for uncommitted changes
  try {
    const { stdout } = await execa("git", ["-C", wtPath, "status", "--porcelain"], {
      stdio: "pipe",
    });
    if (stdout.trim()) {
      throw new Error(
        `Worktree "${name}" has uncommitted changes. Commit or stash before closing.`
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("uncommitted")) throw err;
    // Re-throw the uncommitted changes error
    throw err;
  }

  await execa("git", ["-C", projectPath, "worktree", "remove", wtPath, "--force"], {
    stdio: "pipe",
  });

  // Delete the branch if it still exists
  try {
    await execa("git", ["-C", projectPath, "branch", "-d", branch], {
      stdio: "pipe",
    });
  } catch {
    // Branch might already be gone — ignore
  }
}

export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execa(
    "git",
    ["-C", projectPath, "worktree", "list", "--porcelain"],
    { stdio: "pipe" }
  );

  const worktrees: WorktreeInfo[] = [];
  const blocks = stdout.trim().split(/\n\n/);

  for (const block of blocks) {
    const lines = block.split("\n");
    const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? "";

    if (!branch.includes(BRANCH_PREFIX)) continue;

    const name = branch.replace(`refs/heads/${BRANCH_PREFIX}/`, "");
    worktrees.push({ name, branch: branch.replace("refs/heads/", ""), path: wtPath, projectPath });
  }

  return worktrees;
}

export async function getWorktreeDiff(wtPath: string): Promise<string> {
  try {
    const { stdout } = await execa("git", ["-C", wtPath, "diff", "--stat", "HEAD"], {
      stdio: "pipe",
    });
    return stdout.trim();
  } catch {
    return "";
  }
}
