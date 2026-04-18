import chalk from "chalk";
import { startServer } from "../integrations/n8n.js";

export async function serveCommand(opts: { port?: number }): Promise<void> {
  const { port, close } = await startServer();

  console.log(
    [
      "",
      chalk.green(`ccmux serve running on http://127.0.0.1:${port}`),
      "",
      `  ${chalk.dim("POST")} /session/new   — create a session`,
      `  ${chalk.dim("POST")} /session/close — close a session`,
      `  ${chalk.dim("GET")}  /session/list  — list active sessions`,
      `  ${chalk.dim("GET")}  /health        — health check`,
      "",
      chalk.dim("Press Ctrl+C to stop"),
    ].join("\n")
  );

  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise<never>(() => {});
}
