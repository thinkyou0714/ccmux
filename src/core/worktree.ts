import { execa } from "execa";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { acquireLock, releaseLock } from "./lock.js";

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

// Run git with a fixed locale so we can reliably match its messages (e.g.
// "already exists") regardless of the user's LANG/LC_ALL, and never block on an
// interactive credential prompt.
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
}

/** True when `target` resolves to `base` or a path inside it (traversal guard). */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// I-093: cross-process serialization of worktree mutations.
//
// Concurrent `ccmux auto` runs (e.g. several webhooks fired at once) can call
// `createWorktree`/`deleteWorktree` against the *same* repo simultaneously.
// `git worktree add/remove/prune` all rewrite `.git/worktrees`, and racing them
// corrupts registrations or prunes a sibling's freshly-added worktree. We gate
// every mutation on a per-repository advisory lock (reusing core/lock.ts, which
// already handles stale-PID takeover and Windows EPERM/EACCES retries).

/**
 * Derive a filesystem-safe, per-repository lock key from the project path.
 * The canonical (realpath-resolved) path is hashed so that two spellings of the
 * same repo (symlinks, trailing slash, `..` segments) map to one lock; sha1 is
 * used purely as a collision-resistant fixed-width slug, not for security.
 */
function worktreeLockKey(projectPath: string): string {
  // sha256 (not sha1) purely as a collision-resistant fixed-width slug for the
  // lock filename — not a security primitive, but sha256 avoids CodeQL's
  // weak-crypto flag and is the right default anyway.
  const hash = crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return `worktree-${hash}`;
}

/**
 * Run `fn` while holding the per-repo worktree lock, releasing it in `finally`
 * (success or throw). The lock is deliberately short-lived — held only for the
 * duration of the git mutation — so we never return while still holding it.
 *
 * `acquireLock` throws "already running" when another *live* process (or, for
 * in-process concurrency, this same PID) holds the lock. We treat that as
 * transient contention and retry with bounded exponential backoff + jitter;
 * after the cap we surface a clear error rather than hanging forever.
 */
async function withWorktreeLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = worktreeLockKey(projectPath);
  const maxAttempts = 50; // ~ up to a few seconds of contention; then give up.
  let delay = 20; // ms — grows toward a cap so we don't busy-spin.
  const maxDelay = 250;

  for (let attempt = 1; ; attempt++) {
    try {
      await acquireLock(key);
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;
      // Retryable contention: the lock is held ("already running"); the
      // exclusive create lost a race with another in-process acquire/release so
      // acquireLock surfaced the raw EEXIST (the lock vanished mid-recovery); or
      // a Windows sharing violation (EPERM/EACCES). Anything else (e.g. EROFS on
      // the locks dir) is a real failure — rethrow.
      const contended =
        msg.includes("already running") || code === "EEXIST" || code === "EPERM" || code === "EACCES";
      if (!contended) throw err;
      if (attempt >= maxAttempts) {
        throw new Error(
          `Timed out waiting for the worktree lock on "${projectPath}" ` +
            `(${maxAttempts} attempts). Another ccmux process may be stuck mid-operation.`,
        );
      }
      const jitter = Math.floor(Math.random() * delay);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  try {
    return await fn();
  } finally {
    await releaseLock(key);
  }
}

export function resolveWorktreeBase(override?: string): string {
  return (
    override ??
    process.env.CCMUX_WORKTREE_BASE ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/worktrees`
  );
}

export async function createWorktree(
  name: string,
  projectPath: string,
  options: CreateWorktreeOptions = {},
): Promise<WorktreeInfo> {
  const branch = `${BRANCH_PREFIX}/${name}`;
  const worktreeBase = resolveWorktreeBase(options.worktreeBase);
  const wtPath = path.join(worktreeBase, name);

  await fs.mkdir(worktreeBase, { recursive: true });

  // I-093: serialize the whole add sequence (reconcile → existence check → add)
  // against concurrent createWorktree/deleteWorktree on this repo. listWorktrees
  // and applyWorktreeInclude are called *inside* the lock — they don't re-acquire
  // it (listWorktrees is a pure read), so there's no nested/double acquire.
  return withWorktreeLock(projectPath, async () => {
    // Startup reconciler (idempotent): drop registrations whose directory has
    // already vanished (e.g. a previous crash, or a sibling we don't track) so a
    // stale ghost can't block `git worktree add` at the same path. Best-effort —
    // never fail creation just because prune hiccuped.
    await execa("git", ["-C", projectPath, "worktree", "prune"], {
      stdio: "pipe",
      env: gitEnv(),
    }).catch(() => {});

    // Check if worktree already exists (after prune, so cleared ghosts don't
    // false-positive here).
    const existing = await listWorktrees(projectPath);
    if (existing.some((w) => w.name === name)) {
      throw new Error(`Worktree "${name}" already exists at ${wtPath}`);
    }

    // Create branch and worktree
    try {
      await execa("git", ["-C", projectPath, "worktree", "add", "-b", branch, wtPath], {
        stdio: "pipe",
        env: gitEnv(),
      });
    } catch (err: unknown) {
      // Branch might already exist — try without -b
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        await execa("git", ["-C", projectPath, "worktree", "add", wtPath, branch], {
          stdio: "pipe",
          env: gitEnv(),
        });
      } else {
        throw err;
      }
    }

    // BL-5: copy files listed in .worktreeinclude into the new worktree.
    // Best-effort — failures don't break worktree creation.
    await applyWorktreeInclude(projectPath, wtPath);

    return { name, branch, path: wtPath, projectPath };
  });
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
    // Confine both endpoints to their base dirs — a `.worktreeinclude` line like
    // `../../.ssh/id_rsa` must not read outside the project or write outside the
    // worktree (zip-slip / path traversal).
    if (!isInside(projectPath, src) || !isInside(wtPath, dst)) {
      result.missing.push(rel);
      process.stderr.write(
        `ccmux: .worktreeinclude — refusing path outside project/worktree: "${rel}"\n`,
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
  const worktreeBase = resolveWorktreeBase(options.worktreeBase);
  const wtPath = path.join(worktreeBase, name);
  const branch = `${BRANCH_PREFIX}/${name}`;

  // I-093: serialize the remove sequence against concurrent worktree mutations
  // on this repo (a racing add/prune could otherwise corrupt `.git/worktrees`).
  await withWorktreeLock(projectPath, async () => {
    // Check for uncommitted changes unless the caller explicitly forces removal.
    if (!options.force) {
      let dirty = false;
      try {
        const { stdout } = await execa("git", ["-C", wtPath, "status", "--porcelain"], {
          stdio: "pipe",
          env: gitEnv(),
        });
        dirty = stdout.trim().length > 0;
      } catch {
        // The worktree path is gone or not a git repo (e.g. an orphan left by a
        // crash). There's nothing to protect — fall through to removal instead of
        // failing the close. (Previously this re-threw and wedged the session.)
        dirty = false;
      }
      if (dirty) {
        throw new Error(
          `Worktree "${name}" has uncommitted changes. Commit or stash before closing.`,
        );
      }
    }

    try {
      await execa("git", ["-C", projectPath, "worktree", "remove", wtPath, "--force"], {
        stdio: "pipe",
        env: gitEnv(),
      });
    } catch (err: unknown) {
      // `git worktree remove` can fail to delete the directory on Windows when
      // files are still locked. Surface why (don't silently swallow it), then fall
      // through to a manual, retrying removal.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `ccmux: git worktree remove failed for "${name}" (${msg.slice(0, 120)}) — removing directory directly`,
      );
    }

    // Ensure the worktree directory is actually gone. On Windows, locked handles
    // leave residual files behind, so retry; then prune the stale registration.
    await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await execa("git", ["-C", projectPath, "worktree", "prune"], { stdio: "pipe", env: gitEnv() }).catch(() => {});

    // Delete the branch if it still exists
    try {
      await execa("git", ["-C", projectPath, "branch", "-d", branch], {
        stdio: "pipe",
      });
    } catch {
      // Branch might already be gone — ignore
    }
  });
}

export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  // I-088: use `-z` (NUL) output. In `--porcelain -z` git terminates every
  // attribute line with a single NUL and every record with an extra NUL, so a
  // record boundary is a double-NUL. This is robust to worktree paths that
  // contain spaces or newlines (which would corrupt the previous `\n\n` split)
  // and to detached-HEAD records (no `branch` line). gitEnv() pins LC_ALL=C.
  const { stdout } = await execa(
    "git",
    ["-C", projectPath, "worktree", "list", "--porcelain", "-z"],
    { stdio: "pipe", env: gitEnv() }
  );

  const worktrees: WorktreeInfo[] = [];
  // Records are separated by a double-NUL; trailing NUL(s) yield empty records.
  const blocks = stdout.split("\0\0");

  for (const block of blocks) {
    const lines = block.split("\0").filter((l) => l.length > 0);
    if (lines.length === 0) continue;

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
