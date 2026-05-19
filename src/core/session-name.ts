/**
 * H-01: session name validation.
 *
 * A ccmux session name becomes:
 *   - a git branch under `ccmux/<name>`
 *   - a directory under the worktree base (`<base>/<name>`)
 *   - a tmux / zellij tab label (`ccmux:<name>`)
 *   - a substring of process command lines (`bwrap … --chdir /workspace`)
 *
 * That intersection of {git ref grammar, filesystem paths, shell argv,
 * terminal escape windows} means we need a stricter regex than any single
 * source requires.
 *
 * Strategy: accept the narrow safe alphabet [a-z0-9_-] (case-insensitive),
 * require an alphanumeric leading character (no leading dash — git would
 * also parse it as a flag), cap length, and explicitly reject git's
 * reserved patterns (`..`, `@{`, leading `.`, trailing `.lock`).
 *
 * References:
 *   git-check-ref-format(1)
 *   https://git-scm.com/docs/git-check-ref-format
 */

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const MAX_LEN = 63;

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateSessionName(name: unknown): ValidationResult {
  if (typeof name !== "string") return { ok: false, reason: "not a string" };
  if (name.length === 0) return { ok: false, reason: "empty" };
  if (name.length > MAX_LEN) return { ok: false, reason: `too long (>${MAX_LEN} chars)` };
  if (!SAFE_NAME.test(name)) {
    return {
      ok: false,
      reason: "must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,62} (no leading dash, no spaces, no '/', no '.')",
    };
  }
  // Defense-in-depth: SAFE_NAME already prevents these, but keep the
  // explicit checks as a layered guard in case SAFE_NAME is loosened.
  if (name.endsWith(".lock")) return { ok: false, reason: "ends with reserved .lock" };
  if (name.includes("..")) return { ok: false, reason: "contains '..'" };
  if (name.includes("@{")) return { ok: false, reason: "contains git reflog syntax @{" };
  return { ok: true };
}

/**
 * Throw on invalid name. Use at the boundary where untrusted input
 * (CLI arg, HTTP body field) becomes a session name.
 *
 * Codex review 2026-05-19: the offending name is JSON-stringified before
 * inclusion in the error message so ANSI escapes / NUL / newlines from a
 * malicious input cannot inject terminal control sequences into logs that
 * surface this error.
 */
export function assertSessionName(name: unknown): asserts name is string {
  const r = validateSessionName(name);
  if (!r.ok) {
    throw new Error(`Invalid ccmux session name ${JSON.stringify(String(name))}: ${r.reason}`);
  }
}
