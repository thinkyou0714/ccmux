import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-autoclaw-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  await fs.mkdir(process.env.CCMUX_DIR, { recursive: true });
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("autoclaw shell command quoting", () => {
  it("single-quotes ordinary shell values", async () => {
    const { shSingleQuote } = await import("../src/integrations/autoclaw.js");
    expect(shSingleQuote("claude-sonnet-4-6")).toBe("'claude-sonnet-4-6'");
    expect(shSingleQuote("http://localhost:4101/task")).toBe("'http://localhost:4101/task'");
  });

  it("escapes embedded single quotes for POSIX shells", async () => {
    const { shSingleQuote } = await import("../src/integrations/autoclaw.js");
    expect(shSingleQuote("model'with'quotes")).toBe("'model'\\''with'\\''quotes'");
  });

  it("uses single-quoted config values in resolveClaudeCmd", async () => {
    await fs.writeFile(
      path.join(process.env.CCMUX_DIR!, "config.json"),
      JSON.stringify({
        autoclaw: {
          url: "http://localhost:4101/task",
          model: "claude-sonnet-4-6",
        },
      })
    );

    const { resolveClaudeCmd } = await import("../src/integrations/autoclaw.js");
    await expect(resolveClaudeCmd("autoclaw")).resolves.toBe(
      "ANTHROPIC_BASE_URL='http://localhost:4101/task' claude --model 'claude-sonnet-4-6'"
    );
  });
});
