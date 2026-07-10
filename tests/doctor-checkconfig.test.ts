import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { checkConfig } from "../src/commands/doctor.js";

// checkConfig backs the `ccmux doctor` config check: valid JSON + (on POSIX) a
// 0600 secrets file. It reads ~/.ccmux/config.json directly (no loadConfig).
const posixOnly = process.platform === "win32" ? describe.skip : describe;

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-doctor-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeConfig(mode: number): Promise<void> {
  const file = path.join(tmp, "config.json");
  await fs.writeFile(file, JSON.stringify({ version: 1 }));
  await fs.chmod(file, mode);
}

describe("doctor.checkConfig", () => {
  it("passes for a valid, 0600 config", async () => {
    await writeConfig(0o600);
    const r = await checkConfig();
    expect(r.ok).toBe(true);
  });

  it("fails when the config file is missing", async () => {
    const r = await checkConfig();
    expect(r.ok).toBe(false);
  });

  it("fails on malformed JSON", async () => {
    await fs.writeFile(path.join(tmp, "config.json"), "{ not json");
    const r = await checkConfig();
    expect(r.ok).toBe(false);
  });
});

posixOnly("doctor.checkConfig — POSIX permission check (DX-02)", () => {
  it("flags a group/other-readable config that holds secrets", async () => {
    await writeConfig(0o644);
    const r = await checkConfig();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/mode|chmod|readable/i);
  });
});
