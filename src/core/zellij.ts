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
    // Not inside a mux — print instructions
    console.log(
      `\nNot inside a Zellij/tmux session. Run manually:\n\n  cd "${cwd}" && ${command}\n`
    );
  }
}

async function openZellijTab(name: string, command: string): Promise<void> {
  // Create a new tab
  await execa(ZELLIJ_BIN, ["action", "new-tab", "--name", name], { stdio: "pipe" });

  // Wait briefly for tab to be ready
  await new Promise((r) => setTimeout(r, 300));

  // Send the command
  await execa(ZELLIJ_BIN, ["action", "write-chars", command + "\n"], {
    stdio: "pipe",
  });
}

async function openTmuxWindow(name: string, command: string): Promise<void> {
  await execa(TMUX_BIN, ["new-window", "-n", name, command], { stdio: "pipe" });
}

export async function closeTab(name: string): Promise<void> {
  const mux = detectMultiplexer();
  const tabName = `ccmux:${name}`;

  if (mux === "zellij") {
    // Zellij doesn't have a direct "close tab by name" — send exit to the pane
    // This is a best-effort: switch to tab then close it
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
