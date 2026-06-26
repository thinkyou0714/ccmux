/**
 * BL-6: SQLite dedup queue for inbound session triggers.
 *
 * Purpose: when n8n receives the same GitHub issue twice (retry, replay,
 * duplicate webhook), ccmux should spawn at most one session. The previous
 * implementation had no atomic check — two concurrent `/webhook/github`
 * requests could both pass `getSession(name)` and both call `ccmux auto`.
 *
 * Design:
 *   - SQLite (better-sqlite3 12.10+) with prebuilt Node 22 binaries on
 *     ubuntu / windows / macos, so the dependency is exempt from native
 *     compile across the CI matrix.
 *   - `INSERT OR IGNORE` against a UNIQUE primary key — the only
 *     surviving winner is the first writer. Second caller sees changes=0
 *     and short-circuits before touching the worktree.
 *   - WAL + busy_timeout=5000 so concurrent ccmux processes (multiple
 *     `serve` instances, or test parallel) don't see "database is locked".
 *   - Opt-out via CCMUX_QUEUE_DISABLED=1 — every function becomes a no-op
 *     so users not running the n8n webhook never pay the cost.
 *
 * Lifecycle:
 *   1. n8n webhook handler: `claimSession("issue-42", "github")` — returns
 *      claimed=true for the winner, claimed=false for duplicates.
 *   2. ccmux close: `completeSession("issue-42")` — marks completed_at but
 *      keeps the row for audit.
 *   3. Auto failure rollback: `releaseSession("issue-42")` — removes the
 *      row so a manual re-trigger isn't blocked.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ccmuxDir } from "./paths.js";

function dbPath(): string {
  const dir = ccmuxDir();
  // Ensure parent dir exists for the very first connection (sqlite errors otherwise).
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "queue.db");
}

interface Stmts {
  claimInsert: Database.Statement;
  claimSelect: Database.Statement;
  complete: Database.Statement;
  release: Database.Statement;
}

let _db: Database.Database | null = null;
let _dbPath: string | null = null;
// PERF-01: prepared statements compiled once per connection. better-sqlite3's
// documented best practice is to prepare a statement once and reuse it; the
// previous code called db().prepare(...) on every claim/complete/release, which
// re-compiles the SQL each time — wasteful under webhook bursts.
let _stmts: Stmts | null = null;

function db(): Database.Database {
  const want = dbPath();
  // Honour CCMUX_DIR / HOME changes between calls (tests swap env per case).
  if (_db && _dbPath === want) return _db;
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  // The connection is being (re)opened, so any statements cached against the old
  // handle are now invalid.
  _stmts = null;
  _dbPath = want;
  _db = new Database(want);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.exec(`CREATE TABLE IF NOT EXISTS pending_sessions (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  return _db;
}

function stmts(): Stmts {
  // db() may reset _stmts to null if the connection was (re)opened — call it
  // first, then prepare against the live handle on a cache miss.
  const d = db();
  if (_stmts) return _stmts;
  _stmts = {
    claimInsert: d.prepare(
      "INSERT OR IGNORE INTO pending_sessions(key, source, created_at) VALUES(?, ?, ?)",
    ),
    claimSelect: d.prepare(
      "SELECT source, created_at AS createdAt, completed_at AS completedAt FROM pending_sessions WHERE key = ?",
    ),
    complete: d.prepare("UPDATE pending_sessions SET completed_at = ? WHERE key = ?"),
    release: d.prepare("DELETE FROM pending_sessions WHERE key = ?"),
  };
  return _stmts;
}

function disabled(): boolean {
  return process.env.CCMUX_QUEUE_DISABLED === "1";
}

export interface ClaimResult {
  claimed: boolean;
  existing?: { source: string; createdAt: string; completedAt: string | null };
}

/**
 * Atomically attempt to register a new session. Returns `{ claimed: true }`
 * for the first caller and `{ claimed: false, existing }` for duplicates.
 * With the queue disabled every caller is treated as a winner.
 */
export function claimSession(key: string, source: string): ClaimResult {
  if (disabled()) return { claimed: true };
  const now = new Date().toISOString();
  const s = stmts();
  const r = s.claimInsert.run(key, source, now);
  if (r.changes > 0) return { claimed: true };
  const existing = s.claimSelect.get(key) as
    | { source: string; createdAt: string; completedAt: string | null }
    | undefined;
  return { claimed: false, existing };
}

/** Mark the session as completed (close fired). Keeps the row for audit. */
export function completeSession(key: string): void {
  if (disabled()) return;
  stmts().complete.run(new Date().toISOString(), key);
}

/** Remove the session row entirely. Use when ccmux auto fails before close,
 *  so a manual re-trigger can claim the same key. */
export function releaseSession(key: string): void {
  if (disabled()) return;
  stmts().release.run(key);
}

/** Test helper — close + drop the cached connection so the next call
 *  re-opens against the (possibly swapped) CCMUX_DIR. */
export function _closeDbForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
  _dbPath = null;
  _stmts = null;
}
