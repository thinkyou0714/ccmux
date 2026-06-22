import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { initCommand } from "../src/commands/init.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-init-"));
  process.env.CCMUX_DIR = tmp;
  process.env.HOME = tmp; // so the venv lookup writes inside tmp
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("initCommand (Block D)", () => {
  it("creates a default config without --with-litellm", async () => {
    await initCommand({});
    const cfg = JSON.parse(await fs.readFile(path.join(tmp, "config.json"), "utf-8"));
    expect(cfg.version).toBe(1);
    expect(cfg.autoclaw).toBeDefined();
    // Without --with-litellm we leave the default autoclaw URL untouched.
    expect(typeof cfg.autoclaw.url).toBe("string");
  });

  it("is idempotent (re-running does not crash)", async () => {
    await initCommand({});
    await expect(initCommand({})).resolves.toBeUndefined();
  });

  it("with --with-litellm and no python: surfaces a graceful step-wise error", async () => {
    // Hide every common python binary by shadowing PATH with an empty dir.
    const emptyBin = path.join(tmp, "no-bin");
    await fs.mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    // F-02: initCommand now THROWS on an incomplete bootstrap (instead of
    // process.exit), so the CLI boundary in index.ts turns it into exit 1 —
    // and the failure path is testable without monkey-patching process.exit.
    await expect(initCommand({ withLitellm: true })).rejects.toThrow();
  });
});
