import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;
const SESSIONS_FILE = path.join(CCMUX_DIR, "sessions.json");

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

async function readDB(): Promise<SessionsDB> {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    return JSON.parse(raw) as SessionsDB;
  } catch {
    return { version: 1, sessions: [] };
  }
}

async function writeDB(db: SessionsDB): Promise<void> {
  await fs.mkdir(CCMUX_DIR, { recursive: true });
  const tmp = `${SESSIONS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tmp, SESSIONS_FILE);
}

export async function createSession(
  opts: Omit<Session, "id" | "createdAt" | "updatedAt" | "costUSD" | "status">
): Promise<Session> {
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
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<Session, "id" | "createdAt">>
): Promise<Session> {
  const db = await readDB();
  const idx = db.sessions.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Session ${id} not found`);
  db.sessions[idx] = { ...db.sessions[idx], ...patch, updatedAt: new Date().toISOString() };
  await writeDB(db);
  return db.sessions[idx];
}

export async function getSession(nameOrId: string): Promise<Session | undefined> {
  const db = await readDB();
  return db.sessions.find((s) => s.id === nameOrId || s.name === nameOrId);
}

export async function listSessions(): Promise<Session[]> {
  const db = await readDB();
  return db.sessions.filter((s) => s.status !== "closed");
}

export async function removeSession(id: string): Promise<void> {
  const db = await readDB();
  db.sessions = db.sessions.filter((s) => s.id !== id);
  await writeDB(db);
}

export async function pruneOrphanedSessions(): Promise<number> {
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
}
