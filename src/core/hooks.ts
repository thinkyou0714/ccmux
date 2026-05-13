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
  const script = `#!/usr/bin/env bash
# ccmux Stop hook — checks TASK_STATE.md before allowing Claude to exit.
# Re-read on every stop attempt; guards infinite loops via stop_hook_active.

set -euo pipefail

INPUT=$(cat)
TASK_STATE_FILE="${worktreePath}/TASK_STATE.md"

# --- Infinite loop guard ---
# stop_hook_active=true means this hook already fired this turn.
ALREADY_ACTIVE=$(echo "$INPUT" | grep -o '"stop_hook_active":true' || true)
if [ -n "$ALREADY_ACTIVE" ]; then
  # Allow stop to prevent runaway loop
  exit 0
fi

# --- Check iteration cap ---
ITER=$(grep -oP '(?<=\\*\\*Iteration\\*\\*: )\\d+' "$TASK_STATE_FILE" 2>/dev/null || echo "0")
MAX_ITER="${maxIter}"
if [ "$ITER" -ge "$MAX_ITER" ] 2>/dev/null; then
  echo "ccmux: max iterations ($MAX_ITER) reached — stopping." >&2
  exit 0
fi

# --- Check TASK_STATE.md for completion ---
if [ ! -f "$TASK_STATE_FILE" ]; then
  # No state file — allow stop
  exit 0
fi

STATUS=$(grep -oP '(?<=\\*\\*Status\\*\\*: )\\S+' "$TASK_STATE_FILE" 2>/dev/null || echo "")
COMPLETE_PATTERN=$(grep -o 'CCMUX_COMPLETE' "$TASK_STATE_FILE" 2>/dev/null || true)

if [ "$STATUS" = "complete" ] || [ -n "$COMPLETE_PATTERN" ]; then
  echo "ccmux: TASK_STATE.md status=complete — stopping." >&2
  exit 0
fi

# --- Task not complete: block stop and re-inject context ---
NEXT_STEPS=$(awk '/## Next Steps/{found=1;next} found && /^## /{exit} found{print}' "$TASK_STATE_FILE" | grep '\\- \\[ \\]' | head -5)
if [ -z "$NEXT_STEPS" ]; then
  # No next steps listed — allow stop to avoid loop
  exit 0
fi

cat >&2 <<PROMPT
Continue the task. Re-read TASK_STATE.md at ${worktreePath}/TASK_STATE.md.
Status is not complete. Pending next steps:
${"${NEXT_STEPS}"}

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
 * Blocks file writes outside the worktree directory.
 * Does NOT block reads — read-only access is fine.
 *
 * Note: git worktrees share the object store; they do NOT provide
 * filesystem isolation. This hook is an additional safety layer but
 * bubblewrap/firejail is the only reliable containment (see --sandbox).
 */
async function writePreToolUseHook(
  hooksDir: string,
  worktreePath: string
): Promise<void> {
  const script = `#!/usr/bin/env bash
# ccmux PreToolUse hook — block writes outside the worktree boundary.

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | grep -oP '(?<="tool_name":")[^"]+' || echo "")
WORKTREE="${worktreePath}"

# Only check write tools
case "$TOOL" in
  Write|Edit|NotebookEdit|Create)
    ;;
  *)
    exit 0
    ;;
esac

FILE_PATH=$(echo "$INPUT" | grep -oP '(?<="file_path":")[^"]+' || echo "")
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve to absolute (handles relative paths)
ABS_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Allow writes within worktree
if [[ "$ABS_PATH" == "$WORKTREE"* ]]; then
  exit 0
fi

# Block write outside worktree
echo "ccmux: write to '$ABS_PATH' blocked (outside worktree '$WORKTREE')" >&2
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
