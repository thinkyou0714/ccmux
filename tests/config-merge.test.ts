import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-cfg-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadConfig (G055 — per-section deep merge)", () => {
  it("keeps section defaults when the user supplies a partial section", async () => {
    await fs.writeFile(
      path.join(process.env.CCMUX_DIR!, "config.json"),
      JSON.stringify({ n8n: { enabled: true } }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    // enabled overridden, but webhookUrl/servePort defaults preserved.
    expect(cfg.n8n.enabled).toBe(true);
    expect(cfg.n8n.webhookUrl).toBe("http://127.0.0.1:5679/webhook/ccmux");
    expect(cfg.n8n.servePort).toBe(9090);
  });

  it("preserves obsidian defaults (incl. allowInsecureTLS=false) under partial override", async () => {
    await fs.writeFile(
      path.join(process.env.CCMUX_DIR!, "config.json"),
      JSON.stringify({ obsidian: { apiKey: "k" } }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    expect(cfg.obsidian.apiKey).toBe("k");
    expect(cfg.obsidian.baseUrl).toBe("http://127.0.0.1:27123");
    expect(cfg.obsidian.allowInsecureTLS).toBe(false);
  });

  it("round-trips saveConfig through config.json", async () => {
    const { loadConfig, saveConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    const saved = {
      ...cfg,
      defaultProject: "roundtrip",
      projects: {
        ...cfg.projects,
        roundtrip: { path: tmp, defaultLlm: "autoclaw" as const },
      },
      autoclaw: {
        ...cfg.autoclaw,
        url: "http://localhost:4101/task",
        model: "claude-sonnet-4-6",
      },
    };

    await saveConfig(saved);
    await expect(fs.access(path.join(process.env.CCMUX_DIR!, "config.json.tmp"))).rejects.toThrow();

    vi.resetModules();
    const { loadConfig: reloadConfig } = await import("../src/config/schema.js");
    await expect(reloadConfig()).resolves.toEqual(saved);
  });
});
