import { execa } from "execa";

// Resolve lazily so ZELLIJ_BIN/HOME set after module load are honored, and fall
// back to PATH resolution when HOME is unset (was `undefined/.local/bin/...`).
function zellijBin(): string {
  if (process.env.ZELLIJ_BIN) return process.env.ZELLIJ_BIN;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home ? `${home}/.local/bin/zellij` : "zellij";
}
const TMUX_BIN = "tmux";

// Quote a value for safe interpolation inside a bash double-quoted string
// (escape \ $ " ` so a worktree path can't break out and inject shell).
function shellDQ(value: string): string {
  return `"${value.replace(/[\\$"`]/g, "\\$&")}"`;
}

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
  const fullCmd = `cd ${shellDQ(cwd)} && ${command}`;

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
      await execa(zellijBin(), ["action", "go-to-tab-name", tabName], { stdio: "pipe" });
    } catch {
      // Tab might still be starting — continue anyway
    }
    // Wait for CC to print its prompt
    await new Promise((r) => setTimeout(r, delayMs));
    // Write the prompt
    await execa(zellijBin(), ["action", "write-chars", prompt + "\n"], { stdio: "pipe" });
    // Switch back to previous tab so Cursor user isn't jarred
    await execa(zellijBin(), ["action", "go-to-previous-tab"], { stdio: "pipe" }).catch(() => {});
  } else if (mux === "tmux") {
    await new Promise((r) => setTimeout(r, delayMs));
    await execa(
      TMUX_BIN,
      ["send-keys", "-t", tabName, prompt, "Enter"],
      { stdio: "pipe" }
    );
  }
  // If no mux: prompt was already echoed by openSession — nothing more to do
}

async function openZellijTab(name: string, command: string): Promise<void> {
  await execa(zellijBin(), ["action", "new-tab", "--name", name], { stdio: "pipe" });
  await new Promise((r) => setTimeout(r, 300));
  await execa(zellijBin(), ["action", "write-chars", command + "\n"], { stdio: "pipe" });
}

async function openTmuxWindow(name: string, command: string): Promise<void> {
  await execa(TMUX_BIN, ["new-window", "-n", name, command], { stdio: "pipe" });
}

export async function closeTab(name: string): Promise<void> {
  const mux = detectMultiplexer();
  const tabName = `ccmux:${name}`;

  if (mux === "zellij") {
    try {
      await execa(zellijBin(), ["action", "go-to-tab-name", tabName], { stdio: "pipe" });
      await new Promise((r) => setTimeout(r, 200));
      await execa(zellijBin(), ["action", "close-tab"], { stdio: "pipe" });
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
