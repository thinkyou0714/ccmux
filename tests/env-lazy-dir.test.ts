import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { acquireLock, releaseLock } from "../src/core/lock.js";
import { logsCommand } from "../src/commands/logs.js";
import { writeLocalHandoff } from "../src/commands/close.js";

const origEnv = { ...process.env };
let tmp: string;
let activeDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-lazy-dir-"));
  activeDir = path.join(tmp, "active");
  process.env.CCMUX_DIR = path.join(tmp, "import-time");
});

afterEach(async () => {
  await releaseLock("lazy-lock");
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CCMUX_DIR lazy resolution after module import", () => {
  it("lock files use the current CCMUX_DIR", async () => {
    process.env.CCMUX_DIR = activeDir;

    await acquireLock("lazy-lock");

    await expect(fs.access(path.join(activeDir, "locks", "lazy-lock.lock"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmp, "import-time", "locks", "lazy-lock.lock"))).rejects.toThrow();
  });

  it("logs use the current CCMUX_DIR", async () => {
    process.env.CCMUX_DIR = activeDir;
    await fs.mkdir(path.join(activeDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(activeDir, "logs", "lazy.log"), "hello\n", "utf-8");

    let output = "";
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    });
    try {
      await logsCommand(undefined, { all: true });
    } finally {
      spy.mockRestore();
    }

    expect(output).toContain("lazy.log");
  });

  it("handoffs use the current CCMUX_DIR", async () => {
    process.env.CCMUX_DIR = activeDir;

    await writeLocalHandoff({
      sessionName: "lazy-handoff",
      branch: "ccmux/lazy-handoff",
      diff: "",
    });

    const fileName = `${new Date().toISOString().slice(0, 10)}-lazy-handoff.md`;
    await expect(fs.access(path.join(activeDir, "handoffs", fileName))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmp, "import-time", "handoffs", fileName))).rejects.toThrow();
  });
});
