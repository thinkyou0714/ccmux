import chalk from "chalk";
import { startServer } from "../integrations/n8n.js";
import { invalidateConfigCache } from "../config/schema.js";

export async function serveCommand(opts: { port?: number }): Promise<void> {
  let { port, close, https: isHttps } = await startServer(opts.port);
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
      chalk.dim("Press Ctrl+C to stop") +
        (process.platform === "win32" ? "" : chalk.dim("  ·  kill -HUP <pid> to reload config")),
    ].join("\n")
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // REL-08: loadConfig() memoizes process-wide, so a running serve never picks
  // up an edited ~/.ccmux/config.json. On SIGHUP, drop the cache and rebind the
  // server (startServer re-reads config) so a rotated webhookSecret/authToken,
  // changed port, or toggled integration takes effect without a full restart.
  // SIGHUP is POSIX-only; Windows has no equivalent.
  if (process.platform !== "win32") {
    let reloading = false;
    process.on("SIGHUP", () => {
      void (async () => {
        if (shuttingDown || reloading) return;
        reloading = true;
        console.log("\nSIGHUP — reloading config...");
        try {
          await close();
          invalidateConfigCache();
          ({ port, close, https: isHttps } = await startServer(opts.port));
          console.log(
            chalk.green(
              `reloaded — listening on ${isHttps ? "https" : "http"}://127.0.0.1:${port}`
            )
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`config reload failed, shutting down: ${msg}`));
          process.exit(1);
        } finally {
          reloading = false;
        }
      })();
    });
  }

  // Keep process alive
  await new Promise<never>(() => {});
}
