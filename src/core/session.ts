import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}
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
      if (code !== "EEXIST") throw err;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // The lock disappeared between open/stat/unlink; retry immediately.
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

export type SessionStatus = "created" | "starting" | "idle" | "busy" | "done" | "closed" | "error" | "orphaned";

export interface Session {
  id: string;
  name: string;
  branch: string;
  worktreePath: string;
  projectPath: string;
  zellijTab: string;
  status: SessionStatus;
  pid?: number;
  createdAt: string;
  updatedAt: string;
  costUSD: number;
  project: string;
  llmBackend: "claude" | "autoclaw";
}

interface SessionsDB {
  version: number;
  sessions: Session[];
}

async function backupCorruptDB(raw: string): Promise<void> {
  // Preserve the unparseable file under a timestamped name BEFORE the caller's
  // empty DB gets written back over the original (which would erase every
  // session record). Best-effort: a failed backup must not block the CLI.
  const backup = `${sessionsFile()}.corrupt-${Date.now()}`;
  try {
    await fs.writeFile(backup, raw, { mode: 0o600 });
    process.stderr.write(
      `ccmux: sessions.json was unreadable and has been backed up to ${backup}; ` +
        `starting with an empty session list.\n`,
    );
  } catch {
    // ignore — nothing more we can safely do
  }
}

async function readDB(): Promise<SessionsDB> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionsFile(), "utf-8");
  } catch {
    // Missing or unreadable file — first run, or a transient IO error. Start
    // fresh without a backup (there is nothing meaningful to preserve).
    return { version: 1, sessions: [] };
  }

  try {
    const parsed = JSON.parse(raw) as SessionsDB;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
      throw new Error("sessions.json has an unexpected shape");
    }
    return parsed;
  } catch {
    // Corrupt JSON. Returning an empty DB lets the next writeDB overwrite and
    // destroy the file, so back it up first (see backupCorruptDB).
    await backupCorruptDB(raw);
    return { version: 1, sessions: [] };
  }
}

async function writeDB(db: SessionsDB): Promise<void> {
  await fs.mkdir(ccmuxDir(), { recursive: true });
  const tmp = `${sessionsFile()}.tmp`;
  // REL-05: write → fsync → rename so a crash/power-loss can't leave a
  // zero-length or partially-written sessions.json on filesystems that commit
  // the rename ahead of the file data; the rename is the atomic swap. fsync is
  // POSIX-only — on Windows its latency widens the sessions-lock staleness
  // window (a deferred concern) and the rename already replaces atomically, so
  // we skip it there to leave that path's timing unchanged.
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(db, null, 2));
    if (process.platform !== "win32") {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, sessionsFile());
}

export async function createSession(
  opts: Omit<Session, "id" | "createdAt" | "updatedAt" | "costUSD" | "status">
): Promise<Session> {
  return withSessionLock(async () => {
    const db = await readDB();
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
