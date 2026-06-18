import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { ccmuxDir } from "./paths.js";

function sessionsFile(): string {
  return path.join(ccmuxDir(), "sessions.json");
}

function sessionsLockPath(): string {
  return `${sessionsFile()}.lock`;
}

const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionLock(): Promise<() => Promise<void>> {
  const lockPath = sessionsLockPath();

  while (true) {
    await fs.mkdir(ccmuxDir(), { recursive: true });
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
        );
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Best effort cleanup: another process may already have removed a stale lock.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EEXIST = the lock is held. On Windows, a concurrent O_EXCL create can
      // surface a sharing violation as EPERM/EACCES instead of EEXIST — treat
      // those as "contended, retry" rather than a hard failure (otherwise 25
      // concurrent createSession calls flake on Windows).
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // The lock isn't actually there (the EPERM/EEXIST was a transient race),
        // or it vanished between open/stat — retry immediately.
        continue;
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireSessionLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

// I-063: the ledger is validated with Zod (mirroring config/schema.ts) so a
// structurally-wrong sessions.json is caught at read time and routed to the
// corrupt-backup path, instead of being silently trusted via `as SessionsDB`.
// The public `SessionStatus`/`Session`/`SessionsDB` types are derived from these
// schemas with z.infer, keeping the runtime check and the static type in lockstep.
const SESSION_STATUSES = [
  "created",
  "starting",
  "idle",
  "busy",
  "done",
  "closed",
  "error",
  "orphaned",
] as const;

const SessionStatusSchema = z.enum(SESSION_STATUSES);

const SessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  projectPath: z.string(),
  zellijTab: z.string(),
  status: SessionStatusSchema,
  pid: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  costUSD: z.number(),
  project: z.string(),
  llmBackend: z.enum(["claude", "autoclaw"]),
});

const SessionsDBSchema = z.object({
  version: z.number(),
  sessions: z.array(SessionSchema),
});

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type Session = z.infer<typeof SessionSchema>;
type SessionsDB = z.infer<typeof SessionsDBSchema>;

async function readDB(): Promise<SessionsDB> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionsFile(), "utf-8");
  } catch (err) {
    // No ledger yet (fresh install) is normal — start empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: [] };
    }
    throw err;
  }
  try {
    const json: unknown = JSON.parse(raw);
    // I-063: validate the shape with Zod rather than trusting `as SessionsDB`.
    // A wrong type (sessions not an array, status not a known enum, …) is just
    // as corrupting as bad JSON — the next write would overwrite real rows — so
    // both failure modes converge on the backup-and-throw path below.
    const parsed = SessionsDBSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(z.prettifyError(parsed.error));
    }
    return parsed.data;
  } catch (err) {
    // A corrupt ledger must NOT be silently treated as empty — the next write
    // would overwrite every recorded session. Preserve it for recovery and fail
    // loudly instead.
    const backup = `${sessionsFile()}.corrupt.${Date.now()}`;
    await fs.copyFile(sessionsFile(), backup).catch(() => {});
    throw new Error(
      `ccmux: sessions ledger at ${sessionsFile()} is corrupt — backed up to ${backup}. ` +
        `Inspect/restore it, or delete it to start fresh. (${(err as Error).message})`,
    );
  }
}

async function writeDB(db: SessionsDB): Promise<void> {
  // I-082: durable write. A bare writeFile→rename can still leave the ledger as
  // a 0-byte file (or pointing at an old inode) after a power loss, because the
  // page cache hasn't been flushed when the crash hits. We instead:
  //   1. write the tmp file and fsync its contents before close,
  //   2. atomically rename it over the real ledger,
  //   3. fsync the parent directory so the rename itself is durable.
  // Steps 1+2 guarantee the ledger is never torn; step 3 guarantees the
  // rename survives a crash immediately after it returns.
  const dir = ccmuxDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${sessionsFile()}.tmp`;
  const data = JSON.stringify(db, null, 2);

  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fs.rename(tmp, sessionsFile());

  // Best-effort directory fsync so the rename is durable. The dir handle can't
  // be opened (or sync()'d) on every platform — Windows in particular may throw
  // EPERM/EISDIR/EACCES — so failures here are intentionally swallowed.
  try {
    const dh = await fs.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Directory fsync is unsupported here (e.g. Windows) — the data fsync +
    // atomic rename above already protect against a torn ledger.
  }
}

export async function createSession(
  opts: Omit<Session, "id" | "createdAt" | "updatedAt" | "costUSD" | "status">
): Promise<Session> {
  return withSessionLock(async () => {
    const db = await readDB();
    // The OS lock (core/lock.ts) is meant to prevent same-name sessions, but if
    // it leaks/fails the ledger must still not accumulate duplicate live rows
    // (getSession returns only the first, orphaning the other's worktree/tab).
    if (db.sessions.some((s) => s.name === opts.name && s.status !== "closed")) {
      throw new Error(`Session "${opts.name}" already exists (not closed).`);
    }
    const now = new Date().toISOString();
    const session: Session = {
      ...opts,
      id: randomUUID(),
      status: "created",
      costUSD: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.sessions.push(session);
    await writeDB(db);
    return session;
  });
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<Session, "id" | "createdAt">>
): Promise<Session> {
  return withSessionLock(async () => {
    const db = await readDB();
    const idx = db.sessions.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Session ${id} not found`);
    db.sessions[idx] = { ...db.sessions[idx], ...patch, updatedAt: new Date().toISOString() };
    await writeDB(db);
    return db.sessions[idx];
  });
}

export async function getSession(nameOrId: string): Promise<Session | undefined> {
  const db = await readDB();
  return db.sessions.find((s) => s.id === nameOrId || s.name === nameOrId);
}

/**
 * Default: omit `closed` sessions (the busy/idle dashboard view).
 * Pass `includeClosed: true` to walk the full history (used by --all and by
 * --status=closed in the list command).
 */
export async function listSessions(
  opts: { includeClosed?: boolean } = {}
): Promise<Session[]> {
  const db = await readDB();
  if (opts.includeClosed) return db.sessions;
  return db.sessions.filter((s) => s.status !== "closed");
}

export async function removeSession(id: string): Promise<void> {
  await withSessionLock(async () => {
    const db = await readDB();
    db.sessions = db.sessions.filter((s) => s.id !== id);
    await writeDB(db);
  });
}

export async function pruneOrphanedSessions(): Promise<number> {
  return withSessionLock(async () => {
    const db = await readDB();
    let pruned = 0;

    for (const session of db.sessions) {
      if (session.status === "closed") continue;
      if (!session.pid) continue;

      // Check if PID is still alive
      try {
        process.kill(session.pid, 0);
      } catch {
        session.status = "orphaned";
        session.updatedAt = new Date().toISOString();
        pruned++;
      }
    }

    if (pruned > 0) await writeDB(db);
    return pruned;
  });
}
