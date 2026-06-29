import path from "path";

/**
 * Centralized resolution of every ccmux filesystem path.
 *
 * Before this module the same two expressions —
 *   `process.env.HOME ?? process.env.USERPROFILE ?? ""`            (home dir)
 *   `process.env.CCMUX_DIR ?? `${home}/.ccmux``                    (state dir)
 * — were re-implemented in ~10 files (core/session, core/lock, core/queue,
 * config/schema, commands/{close,logs,doctor,dashboard,…}). Two of those copies
 * (commands/auto, commands/reflect) had drifted: they captured the directory in
 * a module-load-time `const` and dropped the USERPROFILE (Windows) fallback, so
 * they pinned the path to import-time env and broke the lazy-resolution contract
 * the rest of the CLI relies on (see tests/env-lazy-dir.test.ts).
 *
 * Every helper here resolves lazily on each call so tests and the long-lived
 * `serve` daemon can swap CCMUX_DIR / HOME after import and have all dependent
 * paths follow.
 */

/**
 * The user's home directory. Prefers HOME (POSIX), falls back to USERPROFILE
 * (Windows), then "" so a missing home still yields a usable relative path
 * instead of throwing inside path.join.
 */
export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

/**
 * The ccmux state directory (default `~/.ccmux`), overridable with CCMUX_DIR.
 * Never capture this in a module-level const — resolve it per call.
 */
export function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${homeDir()}/.ccmux`;
}

export function claudeDir(): string {
  return path.join(homeDir(), ".claude");
}

export function configFile(): string {
  return path.join(ccmuxDir(), "config.json");
}

export function sessionsFile(): string {
  return path.join(ccmuxDir(), "sessions.json");
}

export function handoffsDir(): string {
  return path.join(ccmuxDir(), "handoffs");
}

export function logsDir(): string {
  return path.join(ccmuxDir(), "logs");
}

export function locksDir(): string {
  return path.join(ccmuxDir(), "locks");
}
