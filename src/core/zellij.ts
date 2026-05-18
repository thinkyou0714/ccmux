import { execa } from "execa";

const ZELLIJ_BIN = process.env.ZELLIJ_BIN ?? `${process.env.HOME}/.local/bin/zellij`;
const TMUX_BIN = "tmux";

export type Multiplexer = "zellij" | "tmux" | "none";

function detectMultiplexer(): Multiplexer {
  if (process.env.ZELLIJ_SESSION_NAME) return "zellij";
  if (process.env.TMUX) return "tmux";
  return "none";
}

export async function openSession(
  name: string,
  cwd: string,
  command: string
): Promise<void> {
  const mux = detectMultiplexer();
  const tabName = `ccmux:${name}`;
  const fullCmd = `cd "${cwd}" && ${command}`;

  if (mux === "zellij") {
    await openZellijTab(tabName, fullCmd);
  } else if (mux === "tmux") {
    await openTmuxWindow(tabName, fullCmd);
  } else {
    console.log(
      `\nNot inside a Zellij/tmux session. Run manually:\n\n  cd "${cwd}" && ${command}\n`
    );
  }
}

/**
 * Send a prompt string to an already-open ccmux tab.
 * Waits for CC to finish startup before typing.
 */
export async function sendToTab(name: string, prompt: string, delayMs = 3000): Promise<void> {
  const mux = detectMultiplexer();
  const tabName = `ccmux:${name}`;

  if (mux === "zellij") {
    // Switch to the tab first
    try {
      await execa(ZELLIJ_BIN, ["action", "go-to-tab-name", tabName], { stdio: "pipe" });
    } catch {
      // Tab might still be starting — continue anyway
    }
    // Wait for CC to print its prompt
    await new Promise((r) => setTimeout(r, delayMs));
    // C-01: Strip non-tab/newline control chars before write-chars (zellij
    // has no -l literal flag; control sequences could re-enter the terminal).
    await execa(ZELLIJ_BIN, ["action", "write-chars", stripCtrl(prompt) + "\n"], { stdio: "pipe" });
    // Switch back to previous tab so Cursor user isn't jarred
    await execa(ZELLIJ_BIN, ["action", "go-to-previous-tab"], { stdio: "pipe" }).catch(() => {});
  } else if (mux === "tmux") {
    await new Promise((r) => setTimeout(r, delayMs));
    // C-01: send-keys interprets `;`, `~`, key names. Use load-buffer +
    // paste-buffer for arbitrary text (raw bytes, no interpretation), then
    // send a separate Enter to submit.
    const bufName = `ccmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await execa(TMUX_BIN, ["load-buffer", "-b", bufName, "-"], {
      input: prompt,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await execa(
      TMUX_BIN,
      ["paste-buffer", "-d", "-p", "-b", bufName, "-t", tabName],
      { stdio: "pipe" }
    );
    await execa(TMUX_BIN, ["send-keys", "-t", tabName, "Enter"], { stdio: "pipe" });
  }
  // If no mux: prompt was already echoed by openSession — nothing more to do
}

async function openZellijTab(name: string, command: string): Promise<void> {
  await execa(ZELLIJ_BIN, ["action", "new-tab", "--name", name], { stdio: "pipe" });
  await new Promise((r) => setTimeout(r, 300));
  // C-01: defense-in-depth — strip control chars before write-chars even
  // though `command` is internally built (cwd + claudeCmd).
  await execa(ZELLIJ_BIN, ["action", "write-chars", stripCtrl(command) + "\n"], { stdio: "pipe" });
}

/**
 * C-01 helper: remove ASCII control bytes that could re-enter the receiving
 * terminal as key sequences. Preserves TAB (0x09) and LF (0x0A) because they
 * are legitimate in shell commands; strips NUL, BS, VT, FF, CR, ESC, DEL.
 */
function stripCtrl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

async function openTmuxWindow(name: string, command: string): Promise<void> {
  await execa(TMUX_BIN, ["new-window", "-n", name, command], { stdio: "pipe" });
}

export async function closeTab(name: string): Promise<void> {
  const mux = detectMultiplexer();
  const tabName = `ccmux:${name}`;

  if (mux === "zellij") {
    try {
      await execa(ZELLIJ_BIN, ["action", "go-to-tab-name", tabName], { stdio: "pipe" });
      await new Promise((r) => setTimeout(r, 200));
      await execa(ZELLIJ_BIN, ["action", "close-tab"], { stdio: "pipe" });
    } catch {
      // Tab might already be gone
    }
  } else if (mux === "tmux") {
    try {
      await execa(TMUX_BIN, ["kill-window", "-t", tabName], { stdio: "pipe" });
    } catch {
      // Window might already be gone
    }
  }
}

export function getMuxInfo(): { type: Multiplexer; session: string | undefined } {
  const type = detectMultiplexer();
  const session =
    type === "zellij"
      ? process.env.ZELLIJ_SESSION_NAME
      : type === "tmux"
        ? process.env.TMUX?.split(",")[0]
        : undefined;
  return { type, session };
}
