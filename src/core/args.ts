import { InvalidArgumentError } from "commander";

/**
 * commander coercion factory for integer options.
 *
 * Why this exists: passing `parseInt` directly as a commander coercion is a
 * well-known footgun — commander calls `coercion(value, previousValue)`, so for
 * an option with a default value `parseInt(value, previousValue)` treats the
 * previous value as the *radix* (e.g. `parseInt("8", 50)` → NaN). This wrapper
 * parses base-10 only, validates that the input is actually an integer, and
 * enforces optional bounds — surfacing a clear error instead of silently
 * coercing to NaN/null and falling back to the default.
 */
export function intArg(min?: number, max?: number) {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new InvalidArgumentError("must be an integer");
    }
    const n = Number.parseInt(value, 10);
    if (min !== undefined && n < min) {
      throw new InvalidArgumentError(`must be >= ${min}`);
    }
    if (max !== undefined && n > max) {
      throw new InvalidArgumentError(`must be <= ${max}`);
    }
    return n;
  };
}

// A session name flows into a git branch (`ccmux/<name>`), a worktree path
// (`path.join(base, name)`), a Zellij tab name, and handoff file names. Without
// validation, `../x`, absolute paths, empty strings, or names invalid as git
// refs escape the base directory (CWE-22) or corrupt worktree state.
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Throws InvalidArgumentError if `name` is unsafe as a branch / path / file name. */
export function validateSessionName(name: string): void {
  if (name.includes("..") || !SESSION_NAME_RE.test(name)) {
    throw new InvalidArgumentError(
      `invalid session name "${name}" — use letters, digits, '.', '_', '-' ` +
        `(1-64 chars, must start with a letter or digit, no "..")`,
    );
  }
}
