import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Keep the heavy deps out — these tests only exercise startServer lifecycle.
vi.mock("../src/commands/auto.js", () => ({ autoCommand: vi.fn(async () => {}) }));
vi.mock("../src/core/queue.js", () => ({
  claimSession: vi.fn(() => ({ claimed: true })),
  releaseSession: vi.fn(),
  completeSession: vi.fn(),
}));

const origEnv = { ...process.env };
let configDir: string;

beforeEach(async () => {
  vi.resetModules();
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-srv-err-"));
  process.env.CCMUX_DIR = configDir;
  process.env.HOME = configDir;
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ version: 1, n8n: {} }),
    "utf-8",
  );
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("I-074 startServer runtime error handling", () => {
  it("exposes an `errored` promise and a working close()", async () => {
    const { startServer } = await import("../src/integrations/n8n.js");
    const handle = await startServer(0);
    try {
      expect(handle.errored).toBeInstanceOf(Promise);
      expect(typeof handle.close).toBe("function");
      // Under normal operation `errored` must stay pending (not resolve early).
      const settled = await Promise.race([
        handle.errored.then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("pending"), 50)),
      ]);
      expect(settled).toBe("pending");
    } finally {
      await handle.close();
    }
  });

  it("rejects the boot promise on a listen error (port already in use)", async () => {
    const { startServer } = await import("../src/integrations/n8n.js");
    const first = await startServer(0);
    try {
      // Re-binding the already-bound port must reject rather than hang.
      await expect(startServer(first.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
