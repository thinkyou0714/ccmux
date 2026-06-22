import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
let dir: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules(); // loadConfig caches the parsed config at module scope
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-cfg-malformed-"));
  dir = path.join(tmp, ".ccmux");
  process.env.CCMUX_DIR = dir;
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

function spyStderr(): { get: () => string; restore: () => void } {
  let out = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
    return true;
  }) as typeof process.stderr.write);
  return { get: () => out, restore: () => spy.mockRestore() };
}

describe("loadConfig malformed-config handling", () => {
  it("warns and falls back to defaults on malformed JSON", async () => {
    await fs.writeFile(path.join(dir, "config.json"), "{ not: valid json ");
    const { loadConfig } = await import("../src/config/schema.js");
    const err = spyStderr();
    const cfg = await loadConfig().finally(() => err.restore());

    expect(err.get()).toMatch(/malformed/);
    expect(cfg.cost.exchangeRate).toBe(155);
    expect(cfg.n8n.servePort).toBe(9090);
  });

  it("warns when the config root is valid JSON but not an object", async () => {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify([1, 2, 3]));
    const { loadConfig } = await import("../src/config/schema.js");
    const err = spyStderr();
    await loadConfig().finally(() => err.restore());

    expect(err.get()).toMatch(/malformed/);
  });

  it("does not warn for a valid partial config and still deep-merges defaults", async () => {
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ cost: { currency: "USD" } }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const err = spyStderr();
    const cfg = await loadConfig().finally(() => err.restore());

    expect(err.get()).toBe("");
    expect(cfg.cost.currency).toBe("USD");
    expect(cfg.cost.exchangeRate).toBe(155); // section default preserved
  });

  it("does not warn when no config file exists (first run)", async () => {
    const { loadConfig } = await import("../src/config/schema.js");
    const err = spyStderr();
    await loadConfig().finally(() => err.restore());

    expect(err.get()).toBe("");
  });

  it("coalesces a null / wrong-typed scalar field to its default (F-08)", async () => {
    await fs.writeFile(
      path.join(dir, "config.json"),
      // worktreeBase:null would otherwise reach path.join(null, name) and crash;
      // zellijSession is the wrong type; defaultProject is a valid override.
      JSON.stringify({ worktreeBase: null, zellijSession: 42, defaultProject: "myproj" }),
    );
    const { loadConfig } = await import("../src/config/schema.js");
    const cfg = await loadConfig();

    expect(cfg.worktreeBase).not.toBeNull();
    expect(typeof cfg.worktreeBase).toBe("string");
    expect(typeof cfg.zellijSession).toBe("string");
    expect(cfg.zellijSession).toBe("lab"); // default, not 42
    expect(cfg.defaultProject).toBe("myproj"); // valid string still overrides
  });
});
