/**
 * C-03 / H-02: explicit env allowlist for spawned child processes.
 *
 * Implicitly inheriting process.env into a child (the Node default) leaks
 * any secret the parent has read — ANTHROPIC_API_KEY, OBSIDIAN_API_KEY,
 * AWS_SESSION_TOKEN, GitHub tokens, etc. We pass only what the child
 * provably needs.
 *
 * Industry pattern: execa({ extendEnv: false, env: {...allowlist} }).
 * Node's spawn() takes effect when an explicit `env` option is given:
 * the parent env is NOT inherited.
 *
 * The list below is the safe baseline for our targets (claude CLI, npx,
 * git, bwrap on Linux). Callers add their own keys via `extra`.
 */

const ALLOWED_KEYS: ReadonlyArray<string> = [
  // POSIX essentials
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // Multiplexer signals (claude / ccmux feature detection)
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  // Windows essentials (cmd.exe shim resolution, %TEMP%, etc.)
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "ComSpec",
  "PATHEXT",
  // ccmux self-signals (set by parent for child to read)
  "CCMUX_SESSION",
  "CCMUX_DIR",
  "CCMUX_PROJECT",
  "CCMUX_WORKTREE_BASE",
  "CLAUDE_CONFIG_DIR",
  // NOTE (codex review 2026-05-19): NODE_OPTIONS / NODE_PATH /
  // NPM_CONFIG_USERCONFIG are deliberately EXCLUDED. They give the child a
  // remote-code-execution primitive (e.g. NODE_OPTIONS="--require /tmp/evil.js")
  // when an attacker can influence the parent environment. If a legitimate
  // need arises (e.g. CI), pass the exact value via `extra` after validation.
];

/**
 * Build a scrubbed environment object.
 *
 * @param extra additional KEY=VALUE pairs to merge after the allowlist;
 *              these win on conflict (typical use: ANTHROPIC_BASE_URL set
 *              by buildClaudeEnv).
 * @returns object suitable for spawn's `env:` option. Pair with
 *          `extendEnv: false` when calling execa.
 */
export function scrubEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED_KEYS) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Test-only helper; production code does not need this. */
export function _allowedKeysForTest(): ReadonlyArray<string> {
  return ALLOWED_KEYS;
}
