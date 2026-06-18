/**
 * Claude Code hook script templates for autonomous ccmux sessions.
 *
 * Two critical hooks are installed per autonomous session:
 *
 * 1. Stop hook — checks TASK_STATE.md before allowing Claude to exit.
 *    Guards against infinite loops via the `stop_hook_active` field.
 *
 * 2. SessionStart hook — re-injects TASK_STATE.md after context compaction.
 *    Fires when session source is "compact" (PreCompact is broken for /compact).
 *
 * Hooks are written to .claude/hooks/ inside each worktree and referenced via
 * a .claude/settings.json overlay. This keeps per-session hook config isolated
 * from the global ~/.claude/settings.json.
 */

import fs from "fs/promises";
import path from "path";

/** Install Stop + SessionStart hooks into the given worktree. */
export async function installSessionHooks(
  worktreePath: string,
  sessionName: string,
  maxIter: number
): Promise<void> {
  const hooksDir = path.join(worktreePath, ".claude", "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  await writeStopHook(hooksDir, worktreePath, sessionName, maxIter);
  await writeSessionStartHook(hooksDir, worktreePath);
  await writePreToolUseHook(hooksDir, worktreePath);
  await writeSettingsOverlay(worktreePath, hooksDir);
}

// ---------------------------------------------------------------------------
// Stop hook
// ---------------------------------------------------------------------------

/**
 * Reads TASK_STATE.md to decide whether to block Claude's exit.
 *
 * Critical: checks `stop_hook_active` in the JSON stdin to prevent
 * infinite loops — without this guard the hook fires forever.
 *
 * BL-3 — Circuit breaker (deadlock prevention):
 *   - Tracks fire timestamps in `.ccmux-circuit.log` (one epoch ts per line).
 *   - If ≥ CIRCUIT_FIRES fires landed within CIRCUIT_WINDOW_SEC, the hook
 *     gives up blocking and lets Claude stop. This breaks the loop when
 *     compaction or a Claude bug starts a runaway Stop→Stop cycle
 *     (oh-my-claudecode #959).
 *   - Detects context-limit error markers in the stdin payload and exits
 *     immediately — blocking would just trap Claude in a "context full"
 *     state with no recovery path.
 *
 * Exit codes:
 *   0 → allow Claude to stop
 *   2 → block stop; stderr content is injected as Claude's next prompt
 */
async function writeStopHook(
  hooksDir: string,
  worktreePath: string,
  sessionName: string,
  maxIter: number
): Promise<void> {
  // Posix path for in-script use.
  const wtPosix = worktreePath.replace(/\\/g, "/");

  const script = `#!/usr/bin/env bash
# ccmux Stop hook — checks TASK_STATE.md before allowing Claude to exit.
# Re-read on every stop attempt; guards infinite loops via stop_hook_active.

set -uo pipefail

TASK_STATE_FILE="${wtPosix}/TASK_STATE.md"
CIRCUIT_FILE="${wtPosix}/.ccmux-circuit.log"
CIRCUIT_FIRES="$\{CCMUX_CIRCUIT_FIRES:-5}"
CIRCUIT_WINDOW_SEC="$\{CCMUX_CIRCUIT_WINDOW_SEC:-60}"

INPUT=$(cat)

# --- BL-3: Circuit breaker (deadlock prevention) ---
# Record this fire and count fires within the rolling window.
NOW=$(date +%s)
mkdir -p "$(dirname "$CIRCUIT_FILE")" 2>/dev/null || true
echo "$NOW" >> "$CIRCUIT_FILE" 2>/dev/null || true
if [ -f "$CIRCUIT_FILE" ]; then
  CUTOFF=$((NOW - CIRCUIT_WINDOW_SEC))
  TRIMMED=$(awk -v cutoff="$CUTOFF" '$1+0 >= cutoff' "$CIRCUIT_FILE" 2>/dev/null || true)
  if [ -n "$TRIMMED" ]; then
    echo "$TRIMMED" > "$CIRCUIT_FILE" 2>/dev/null || true
  fi
  FIRES=$(echo "$TRIMMED" | grep -c . 2>/dev/null || true)
  FIRES=$\{FIRES:-0}
  if [ "$FIRES" -ge "$CIRCUIT_FIRES" ] 2>/dev/null; then
    echo "ccmux: circuit breaker tripped ($FIRES fires in $\{CIRCUIT_WINDOW_SEC}s) — allowing stop." >&2
    exit 0
  fi
fi

# --- BL-3: Context-limit pattern detection ---
# Blocking when context is full just traps Claude in a no-recovery loop.
if echo "$INPUT" | grep -iEq 'context_limit|context_window|context_exceeded|token_limit|prompt_too_long|context_length_exceeded|max_tokens_exceeded' 2>/dev/null; then
  echo "ccmux: context-limit signal detected — allowing stop (compaction needed)." >&2
  exit 0
fi

# --- BL-4: ccusage cost capture (best-effort) ---
# Record running cost into TASK_STATE.md so handoffs preserve it. We invoke
# ccusage directly and ignore failures: missing binary / unknown session id /
# ccusage version mismatch all degrade to "no cost line written" rather than
# blocking the Stop hook. CCMUX_DISABLE_CCUSAGE=1 to opt out completely.
if [ "$\{CCMUX_DISABLE_CCUSAGE:-0}" != "1" ] && [ -f "$TASK_STATE_FILE" ]; then
  SESSION_ID=$(echo "$INPUT" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => raw += c);
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(raw).session_id || ""); } catch {}
    });
  ' 2>/dev/null || true)
  if [ -n "$SESSION_ID" ]; then
    COST=$(ccusage session --id "$SESSION_ID" --json --jq '.sessions[0].costUSD // 0' 2>/dev/null)
    if [ -n "$COST" ]; then
      node -e '
        const fs = require("fs");
        const [file, cost] = [process.argv[1], process.argv[2]];
        try {
          let txt = fs.readFileSync(file, "utf-8");
          const line = "- **Cost**: $" + cost + " USD";
          // Use replacer functions so the literal "$" / "$1" inside the
          // line value (e.g. "$1.23") is NOT re-interpreted as a capture
          // group reference by String.prototype.replace.
          if (/^- \\*\\*Cost\\*\\*:/m.test(txt)) {
            txt = txt.replace(/^- \\*\\*Cost\\*\\*:.*$/m, () => line);
          } else if (/^- \\*\\*Last Updated\\*\\*:/m.test(txt)) {
            txt = txt.replace(/^(- \\*\\*Last Updated\\*\\*:.*)$/m, (_, lu) => line + "\\n" + lu);
          }
          fs.writeFileSync(file, txt, "utf-8");
        } catch { /* never block */ }
      ' "$TASK_STATE_FILE" "$COST" 2>/dev/null || true
    fi
  fi
fi

# --- Infinite loop guard ---
# stop_hook_active=true means this hook already fired this turn.
if echo "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' 2>/dev/null; then
  exit 0
fi

# Parse iteration / status via node (portable: node is guaranteed wherever
# Claude Code hooks run).
iter_from_state() {
  if [ ! -f "$TASK_STATE_FILE" ]; then echo "0"; return; fi
  node -e '
    const fs = require("fs");
    try {
      const txt = fs.readFileSync(process.argv[1], "utf-8");
      const m = txt.match(/\\*\\*Iteration\\*\\*:\\s*(\\d+)/);
      process.stdout.write(m ? m[1] : "0");
    } catch { process.stdout.write("0"); }
  ' "$TASK_STATE_FILE" 2>/dev/null || echo "0"
}

status_from_state() {
  if [ ! -f "$TASK_STATE_FILE" ]; then echo ""; return; fi
  node -e '
    const fs = require("fs");
    try {
      const txt = fs.readFileSync(process.argv[1], "utf-8");
      const m = txt.match(/\\*\\*Status\\*\\*:\\s*(\\S+)/);
      process.stdout.write(m ? m[1] : "");
    } catch { /* empty */ }
  ' "$TASK_STATE_FILE" 2>/dev/null || true
}

# --- Check iteration cap ---
ITER=$(iter_from_state)
MAX_ITER="${maxIter}"
if [ "$ITER" -ge "$MAX_ITER" ] 2>/dev/null; then
  echo "ccmux: max iterations ($MAX_ITER) reached — stopping." >&2
  exit 0
fi

# --- Check TASK_STATE.md for completion ---
if [ ! -f "$TASK_STATE_FILE" ]; then
  exit 0
fi

STATUS=$(status_from_state)
if [ "$STATUS" = "complete" ] || grep -q 'CCMUX_COMPLETE' "$TASK_STATE_FILE" 2>/dev/null; then
  echo "ccmux: TASK_STATE.md status=complete — stopping." >&2
  exit 0
fi

# --- Task not complete: block stop and re-inject context ---
NEXT_STEPS=$(awk '/## Next Steps/{found=1;next} found && /^## /{exit} found{print}' "$TASK_STATE_FILE" 2>/dev/null | grep -E '^- \\[ \\]' | head -5)
if [ -z "$NEXT_STEPS" ]; then
  exit 0
fi

cat >&2 <<PROMPT
Continue the task. Re-read TASK_STATE.md at ${wtPosix}/TASK_STATE.md.
Status is not complete. Pending next steps:
$\{NEXT_STEPS}

Update TASK_STATE.md as you progress. Output CCMUX_COMPLETE when done.
Session: ${sessionName}
PROMPT

exit 2
`;

  const file = path.join(hooksDir, "stop.sh");
  await fs.writeFile(file, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// SessionStart hook (fires after context compaction)
// ---------------------------------------------------------------------------

/**
 * Re-injects TASK_STATE.md when Claude restarts after context compaction.
 * PreCompact hooks are broken for manual /compact (Issue #13572); using
 * SessionStart with source="compact" is the reliable alternative.
 */
async function writeSessionStartHook(
  hooksDir: string,
  worktreePath: string
): Promise<void> {
  const script = `#!/usr/bin/env bash
# ccmux SessionStart hook — re-injects TASK_STATE.md after compaction.
# Only fires when session source is "compact".

set -euo pipefail

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | grep -oP '(?<="source":")[^"]+' || echo "")

if [ "$SOURCE" != "compact" ]; then
  exit 0
fi

TASK_STATE_FILE="${worktreePath}/TASK_STATE.md"

if [ ! -f "$TASK_STATE_FILE" ]; then
  exit 0
fi

echo "=== ccmux: context was compacted — restoring session state ===" >&2
echo "" >&2
cat "$TASK_STATE_FILE" >&2
echo "" >&2
echo "Re-read the TASK_STATE above and continue where you left off." >&2
`;

  const file = path.join(hooksDir, "session-start.sh");
  await fs.writeFile(file, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// PreToolUse hook (filesystem boundary enforcement)
// ---------------------------------------------------------------------------

/**
 * Blocks file writes outside the worktree directory AND blocks Bash
 * invocations matching a destructive-command blocklist (BL-2).
 *
 * Background: CLAUDE.md text rules are routinely "read and ignored" by the
 * model — the only reliable defense is an out-of-process check. Real LAB
 * incidents driving this list:
 *   - drizzle-kit push --force          → wiped a production database
 *   - docker compose up -d (prod)        → started prod services in CI
 *   - cat .env / cat ~/.aws/credentials  → exfiltrated credentials to log
 *   - git push --force on protected refs → rewrote shared history
 *
 * Patterns are matched against the *concatenated* Bash command string (we
 * scan with `grep -E`, not parse shell), so they trip on any subshell or
 * compound command containing the destructive token.
 *
 * Read-only tools and writes inside the worktree are unaffected.
 */
async function writePreToolUseHook(
  hooksDir: string,
  worktreePath: string
): Promise<void> {
  // Posix path for the WORKTREE check inside bash (forward slashes work on
  // Windows MSYS / WSL / Linux / macOS uniformly when matched as a prefix).
  const wtPosix = worktreePath.replace(/\\/g, "/");

  const script = `#!/usr/bin/env bash
# ccmux PreToolUse hook — write-boundary + Bash destructive-command blocklist (BL-2).
#
# Uses python3 for JSON parsing for portability — grep -P is unreliable on
# busybox/MSYS/non-UTF-8 locales. python3 ships with every host that runs
# Claude Code hooks.

set -uo pipefail

WORKTREE="${wtPosix}"

# Read stdin once into a temp file so we can pipe it to python repeatedly.
TMP_INPUT=$(mktemp 2>/dev/null || echo "/tmp/ccmux-hook-$$")
trap 'rm -f "$TMP_INPUT"' EXIT
cat > "$TMP_INPUT"

extract() {
  # extract <dotted-path>  — prints value or empty.
  # Uses node for portability (Claude Code is itself a node process, so
  # node is guaranteed to be on PATH wherever hooks run).
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[2], "utf-8")); }
    catch { process.exit(0); }
    let cur = d;
    for (const p of key.split(".")) {
      if (cur && typeof cur === "object" && p in cur) cur = cur[p];
      else { cur = null; break; }
    }
    if (cur !== null && (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean")) {
      process.stdout.write(String(cur));
    }
  ' "$1" "$TMP_INPUT" 2>/dev/null || true
}

TOOL=$(extract tool_name)
[ -z "$TOOL" ] && TOOL=$(extract toolName)

# --- BL-2: Destructive Bash command blocklist ---
if [ "$TOOL" = "Bash" ]; then
  CMD=$(extract tool_input.command)
  [ -z "$CMD" ] && CMD=$(extract toolInput.command)

  if [ "$\{CCMUX_BLOCKLIST_OVERRIDE:-0}" != "1" ] && [ -n "$CMD" ]; then
    DESTRUCTIVE='drizzle-kit[[:space:]]+push[[:space:]]+.*--force|prisma[[:space:]]+migrate[[:space:]]+(reset|deploy[[:space:]]+--force)|DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)|TRUNCATE[[:space:]]+TABLE|DELETE[[:space:]]+FROM[[:space:]]+[^;]*WHERE[[:space:]]+(1=1|true)|rm[[:space:]]+-rf[[:space:]]+(/|~|--no-preserve-root)|git[[:space:]]+push[[:space:]]+(.*--force|-f[[:space:]]|-f$)|git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+origin|git[[:space:]]+clean[[:space:]]+-fdx|docker[[:space:]]+(compose[[:space:]]+)?up[[:space:]]+.*-d.*(prod|production)|kubectl[[:space:]]+delete[[:space:]]+(namespace|ns|all)|terraform[[:space:]]+destroy|supabase[[:space:]]+db[[:space:]]+reset|psql[[:space:]]+.*-c[[:space:]]+.{0,3}DROP|mongo[[:space:]]+.*dropDatabase|aws[[:space:]]+s3[[:space:]]+rb[[:space:]]+.*--force|gh[[:space:]]+repo[[:space:]]+delete[[:space:]]+.*--yes|npm[[:space:]]+publish|cargo[[:space:]]+publish|cat[[:space:]]+[^|]*\\.env|cat[[:space:]]+[^|]*credentials|cat[[:space:]]+[^|]*\\.aws/|cat[[:space:]]+[^|]*id_(rsa|ed25519)|curl[[:space:]]+.*\\.env|--no-verify|core\\.hooksPath='

    MATCHED=$(echo "$CMD" | grep -oE "$DESTRUCTIVE" 2>/dev/null | head -1 || true)
    if [ -n "$MATCHED" ]; then
      {
        echo "ccmux BL-2: destructive command blocked."
        echo "  matched: $MATCHED"
        echo "  full:    $CMD"
        echo ""
        echo "If this is genuinely required (e.g. local-only teardown), retry with"
        echo "CCMUX_BLOCKLIST_OVERRIDE=1 in the environment and document why."
      } >&2
      exit 2
    fi
  fi

  # Bash command passes blocklist — fall through.
  exit 0
fi

# --- Write boundary enforcement ---
case "$TOOL" in
  Write|Edit|NotebookEdit|Create)
    ;;
  *)
    exit 0
    ;;
esac

FILE_PATH=$(extract tool_input.file_path)
[ -z "$FILE_PATH" ] && FILE_PATH=$(extract toolInput.file_path)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize to forward slashes and check prefix.
ABS_PATH=$(echo "$FILE_PATH" | tr '\\\\' '/')
if [ "$\{ABS_PATH#$WORKTREE}" != "$ABS_PATH" ]; then
  # Starts with worktree → allow
  exit 0
fi

# Try realpath if available (on Linux/WSL/macOS).
if command -v realpath >/dev/null 2>&1; then
  RP=$(realpath -m "$FILE_PATH" 2>/dev/null | tr '\\\\' '/' || true)
  if [ -n "$RP" ] && [ "$\{RP#$WORKTREE}" != "$RP" ]; then
    exit 0
  fi
fi

echo "ccmux: write to '$FILE_PATH' blocked (outside worktree '$WORKTREE')" >&2
exit 2
`;

  const file = path.join(hooksDir, "pre-tool-use.sh");
  await fs.writeFile(file, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// .claude/settings.json overlay
// ---------------------------------------------------------------------------

/**
 * Write a per-worktree settings.json that:
 * - Registers the three hook scripts
 * - Sets disallowedTools (not allowedTools — which is ignored in bypass mode)
 * - Blocks dangerous outbound git/curl commands
 */
async function writeSettingsOverlay(
  worktreePath: string,
  hooksDir: string
): Promise<void> {
  const settingsDir = path.join(worktreePath, ".claude");
  await fs.mkdir(settingsDir, { recursive: true });

  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: path.join(hooksDir, "stop.sh"),
              timeout: 10,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: path.join(hooksDir, "session-start.sh"),
              timeout: 10,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: path.join(hooksDir, "pre-tool-use.sh"),
              timeout: 5,
            },
          ],
        },
      ],
    },
    // disallowedTools blocks tools even in --dangerously-skip-permissions mode
    // (allowedTools does NOT constrain bypassPermissions — use this instead)
    permissions: {
      deny: [
        "Bash(git push *)",
        "Bash(git remote *)",
        "Bash(curl api.anthropic.com*)",
        "Bash(wget https://api.anthropic.com*)",
        "Bash(sudo *)",
        // Alternate push / file-write routes that bypass the Bash blocklist.
        "mcp__github__push_files",
        "mcp__github__create_or_update_file",
        "mcp__github__merge_pull_request",
        "mcp__github__delete_file",
        "mcp__github__update_pull_request_branch",
      ],
    },
  };

  const settingsFile = path.join(settingsDir, "settings.json");
  // Only write if not already present (don't overwrite user's existing config)
  try {
    await fs.access(settingsFile);
  } catch {
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
  }
}
