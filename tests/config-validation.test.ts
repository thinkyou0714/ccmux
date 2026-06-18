import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
const origEnv = { ...process.env };

async function writeConfig(body: string): Promise<void> {
  await fs.writeFile(path.join(process.env.CCMUX_DIR!, "config.json"), body);
}

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-cfgval-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadConfig — Zod validation (P0 1.4)", () => {
  it("returns defaults when no config file exists (fresh install)", async () => {
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    expect(cfg.cost.currency).toBe("JPY");
    expect(cfg.n8n.servePort).toBe(9090);
    expect(cfg.projects).toEqual({});
  });

  it("deep-merges a partial section, filling inner defaults", async () => {
    await writeConfig(JSON.stringify({ n8n: { enabled: true } }));
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    expect(cfg.n8n.enabled).toBe(true);
    expect(cfg.n8n.webhookUrl).toBe("http://127.0.0.1:5679/webhook/ccmux");
    expect(cfg.n8n.servePort).toBe(9090);
    // sibling sections untouched
    expect(cfg.cost.currency).toBe("JPY");
  });

  it("rejects an invalid enum value with an actionable error", async () => {
    await writeConfig(JSON.stringify({ cost: { currency: "EUR" } }));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("rejects a wrong-typed field (servePort as string)", async () => {
    await writeConfig(JSON.stringify({ n8n: { servePort: "9090" } }));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("surfaces malformed JSON instead of silently defaulting", async () => {
    await writeConfig("{ not valid json ");
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/i);
  });

  it("validates entries inside the projects record", async () => {
    // A project missing the required `path` must be rejected.
    await writeConfig(JSON.stringify({ projects: { foo: { claudeMd: "x" } } }));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("fills per-project defaultLlm default and accepts a valid project", async () => {
    await writeConfig(
      JSON.stringify({ projects: { foo: { path: "/repo/foo" } } }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    expect(cfg.projects.foo.path).toBe("/repo/foo");
    expect(cfg.projects.foo.defaultLlm).toBe("claude");
  });

  it("strips unknown keys (forward-compatible) while keeping known ones", async () => {
    await writeConfig(
      JSON.stringify({ zellijSession: "lab2", futureField: 123 }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();
    expect(cfg.zellijSession).toBe("lab2");
    expect((cfg as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });
});

describe("loadConfig — numeric & edge validation", () => {
  it.each([
    ["servePort out of range", { n8n: { servePort: 70000 } }],
    ["servePort negative", { n8n: { servePort: -1 } }],
    ["servePort non-integer", { n8n: { servePort: 99.9 } }],
    ["exchangeRate zero", { cost: { exchangeRate: 0 } }],
    ["exchangeRate negative", { cost: { exchangeRate: -5 } }],
    ["budgetUSD non-positive", { cost: { budgetUSD: 0 } }],
  ])("rejects %s", async (_label, body) => {
    await writeConfig(JSON.stringify(body));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("rejects a null section", async () => {
    await writeConfig(JSON.stringify({ n8n: null }));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("rejects a one-sided n8n.tls (keyFile required when tls is present)", async () => {
    await writeConfig(JSON.stringify({ n8n: { tls: { certFile: "/c.pem" } } }));
    const { loadConfig } = await import("../src/config/schema.js");
    await expect(loadConfig()).rejects.toThrow(/invalid config/i);
  });

  it("round-trips: initConfig writes a config that reloads cleanly to defaults", async () => {
    const m = await import("../src/config/schema.js");
    await m.initConfig(); // writes DEFAULTS to disk
    // Fresh module instance reads the serialized file from disk (bypasses the
    // in-memory _config cache), proving the written form re-validates.
    vi.resetModules();
    const m2 = await import("../src/config/schema.js");
    const reloaded = await m2.loadConfig();
    expect(reloaded.cost.currency).toBe("JPY");
    expect(reloaded.n8n.servePort).toBe(9090);
    expect(reloaded.obsidian.allowInsecureTLS).toBe(false);
    expect(reloaded.autoclaw.url).toBe("http://autoclaw:3101/task");
  });
});
