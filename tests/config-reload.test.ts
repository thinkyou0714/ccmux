import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules(); // fresh module-level _config per test
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-reload-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("REL-08: config cache invalidation", () => {
  it("loadConfig memoizes; invalidateConfigCache forces a re-read from disk", async () => {
    const cfgFile = path.join(tmp, "config.json");
    await fs.writeFile(cfgFile, JSON.stringify({ n8n: { servePort: 1111 } }));

    const { loadConfig, invalidateConfigCache } = await import("../src/config/schema.js");

    expect((await loadConfig()).n8n.servePort).toBe(1111);

    // External edit while the process still holds the cached config.
    await fs.writeFile(cfgFile, JSON.stringify({ n8n: { servePort: 2222 } }));
    // Still cached — the edit is not visible yet (the REL-08 staleness).
    expect((await loadConfig()).n8n.servePort).toBe(1111);

    // After invalidation the next read reflects the new value.
    invalidateConfigCache();
    expect((await loadConfig()).n8n.servePort).toBe(2222);
  });
});
