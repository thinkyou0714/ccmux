import { execa } from "execa";
import path from "path";
import fs from "fs/promises";
import { homeDir } from "./paths.js";

export interface WorktreeInfo {
  name: string;
  branch: string;
  path: string;
  projectPath: string;
}

export interface CreateWorktreeOptions {
  /**
   * Override the worktree base directory. Resolution order (highest first):
   *   1. `options.worktreeBase` (passed by caller — typically `cfg.worktreeBase`)
   *   2. `CCMUX_WORKTREE_BASE` env var (escape hatch for one-off runs)
   *   3. `${HOME}/worktrees` fallback (unchanged from pre-Phase 0 behavior)
   */
  worktreeBase?: string;
}

export interface DeleteWorktreeOptions extends CreateWorktreeOptions {
  /**
   * Skip the pre-removal dirty worktree guard when true.
   * `git worktree remove` is still invoked with `--force` either way.
   */
  force?: boolean;
}

const BRANCH_PREFIX = "ccmux";

const SESSION_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Reject session names that could escape the worktree base via path traversal
 * (CWE-22). A name becomes both a directory under `worktreeBase` (path.join) and
 * a git branch segment, so disallow `..`/`.` segments, absolute paths, a leading
 * `-` (git option injection), and anything outside a conservative charset.
 */
export function validateSessionName(name: string): void {
  if (
    !name ||
    name.length > 128 ||
    !SESSION_NAME_RE.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.split("/").some((seg) => seg === ".." || seg === ".")
  ) {
    throw new Error(`Invalid session name: ${JSON.stringify(name).slice(0, 80)}`);
  }
}

export function resolveWorktreeBase(override?: string): string {
  return (
    override ??
    process.env.CCMUX_WORKTREE_BASE ??
    `${homeDir()}/worktrees`
  );
}

export async function createWorktree(
  name: string,
  projectPath: string,
  options: CreateWorktreeOptions = {},
): Promise<WorktreeInfo> {
  validateSessionName(name);
  const branch = `${BRANCH_PREFIX}/${name}`;
  const worktreeBase = resolveWorktreeBase(options.worktreeBase);
  const wtPath = path.join(worktreeBase, name);

  await fs.mkdir(worktreeBase, { recursive: true });

  // Check if worktree already exists
  const existing = await listWorktrees(projectPath);
  if (existing.some((w) => w.name === name)) {
    throw new Error(`Worktree "${name}" already exists at ${wtPath}`);
  }

  // Create branch and worktree
  try {
    await execa("git", ["-C", projectPath, "worktree", "add", "-b", branch, "--", wtPath], {
      stdio: "pipe",
    });
  } catch (err: unknown) {
    // Branch might already exist — try without -b
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      await execa("git", ["-C", projectPath, "worktree", "add", "--", wtPath, branch], {
        stdio: "pipe",
      });
    } else {
      throw err;
    }
  }

  // BL-5: copy files listed in .worktreeinclude into the new worktree.
  // Best-effort — failures don't break worktree creation.
  await applyWorktreeInclude(projectPath, wtPath);

  return { name, branch, path: wtPath, projectPath };
}

/** True iff `target` is `base` itself or a path strictly beneath it. Uses
 * path.relative so `..` segments and absolute paths are rejected cross-platform. */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * BL-5: read `.worktreeinclude` (gitignore-style, but for files we DO want
 * copied into a worktree even though they are typically gitignored — `.env`,
 * `secrets.json`, IDE config). Each non-comment, non-empty line is a path
 * relative to `projectPath`, copied to the same relative path under `wtPath`.
 *
 * No glob support. Missing source files are silently skipped (warning to
 * stderr) so a partially-populated `.worktreeinclude` doesn't fail the worktree.
 */
export async function applyWorktreeInclude(
  projectPath: string,
  wtPath: string,
): Promise<{ copied: string[]; missing: string[] }> {
  const cfgFile = path.join(projectPath, ".worktreeinclude");
  const result = { copied: [] as string[], missing: [] as string[] };

  let raw: string;
  try {
    raw = await fs.readFile(cfgFile, "utf-8");
  } catch {
    return result; // no .worktreeinclude → nothing to do
  }

  const entries = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  for (const rel of entries) {
    const src = path.resolve(projectPath, rel);
    const dst = path.resolve(wtPath, rel);
    // SEC: `.worktreeinclude` ships inside the repo, so on the webhook lane an
    // attacker-controlled branch could list `../../../.ssh/authorized_keys` (or
    // an absolute path). path.resolve happily follows `..`/absolute entries, so
    // refuse anything whose source escapes the project or whose destination
    // escapes the new worktree before reading or writing a single byte.
    if (!isInside(projectPath, src) || !isInside(wtPath, dst)) {
      result.missing.push(rel);
      process.stderr.write(
        `ccmux: .worktreeinclude — refusing "${rel}" (path escapes the project/worktree)\n`,
      );
      continue;
    }
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      result.copied.push(rel);
    } catch (err: unknown) {
      result.missing.push(rel);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `ccmux: .worktreeinclude — could not copy "${rel}" (${msg.slice(0, 100)})\n`,
      );
    }
  }

  return result;
}

export async function deleteWorktree(
  name: string,
  projectPath: string,
  options: DeleteWorktreeOptions = {},
): Promise<void> {
  validateSessionName(name);
  const worktreeBase = resolveWorktreeBase(options.worktreeBase);
  const wtPath = path.join(worktreeBase, name);
  const branch = `${BRANCH_PREFIX}/${name}`;

  // Check for uncommitted changes unless the caller explicitly forces removal.
  if (!options.force) {
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
  }

  try {
    // SEC-03: `--` terminates option parsing so the worktree path can never be
    // read as a git flag (CVE-2024-35241 class); --force must precede it.
    await execa("git", ["-C", projectPath, "worktree", "remove", "--force", "--", wtPath], {
      stdio: "pipe",
    });
  } catch {
    // `git worktree remove` can fail to delete the directory on Windows when
    // files are still locked. Fall through to a manual, retrying removal.
  }

  // Ensure the worktree directory is actually gone. On Windows, locked handles
  // leave residual files behind, so retry; then prune the stale registration.
  await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await execa("git", ["-C", projectPath, "worktree", "prune"], { stdio: "pipe" }).catch(() => {});

  // Delete the branch if it still exists
  try {
    // SEC-03: `--` before the branch name closes the option-injection surface.
    await execa("git", ["-C", projectPath, "branch", "-d", "--", branch], {
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

    // Only ccmux-managed worktrees: branches under `refs/heads/ccmux/`. The old
    // `branch.includes("ccmux")` substring match also captured unrelated user
    // branches that merely contained the word (e.g. `feature/ccmux-notes`),
    // which could then be listed — and deleted — by ccmux as if it owned them.
    const refPrefix = `refs/heads/${BRANCH_PREFIX}/`;
    if (!branch.startsWith(refPrefix)) continue;

    const name = branch.slice(refPrefix.length);
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
