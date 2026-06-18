import chalk from "chalk";
import { startServer } from "../integrations/n8n.js";

export async function serveCommand(opts: { port?: number }): Promise<void> {
  const { port, close, https: isHttps, errored } = await startServer(opts.port);
  const scheme = isHttps ? "https" : "http";

  console.log(
    [
      "",
      chalk.green(`ccmux serve running on ${scheme}://127.0.0.1:${port}`),
      "",
      `  ${chalk.dim("POST")} /session/new   — create a session`,
      `  ${chalk.dim("POST")} /session/close — close a session`,
      `  ${chalk.dim("GET")}  /session/list  — list active sessions`,
      `  ${chalk.dim("GET")}  /health        — health check`,
      `  ${chalk.dim("POST")} /webhook/github — GitHub issue → session`,
      "",
      chalk.dim("Press Ctrl+C to stop"),
    ].join("\n")
  );

  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // I-074: keep the process alive until either a signal handler exits it, or the
  // server emits a fatal runtime error. Previously this was `new Promise(()=>{})`
  // which hung forever even after the listener died. `errored` resolves on a
  // post-listen 'error' (process.exitCode already set to 1 by startServer); we
  // then close gracefully and let the process terminate.
  const err = await errored;
  console.error(chalk.red(`\nServer error — shutting down: ${err.message}`));
  await close().catch(() => {});
}
