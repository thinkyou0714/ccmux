import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

let tmp: string;
const origEnv = { ...process.env };

// POSIX file modes only; Windows does not model group/other perm bits.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

beforeEach(async () => {
  vi.resetModules(); // loadConfig caches the parsed config at module scope
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-perms-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

async function modeOf(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

posixOnly("DX-02: config secret-file permissions", () => {
  it("saveConfig re-tightens a pre-existing group/world-readable config to 0600", async () => {
    const cfgFile = path.join(tmp, "config.json");
    await fs.writeFile(cfgFile, JSON.stringify({ version: 1 }));
    await fs.chmod(cfgFile, 0o644);
    expect(await modeOf(cfgFile)).toBe(0o644);

    const { loadConfig, saveConfig } = await import("../src/config/schema.js");
    await saveConfig(await loadConfig());

    expect(await modeOf(cfgFile)).toBe(0o600);
  });

  it("doctor checkConfig warns when the config is group/other-accessible", async () => {
    const cfgFile = path.join(tmp, "config.json");
    await fs.writeFile(cfgFile, JSON.stringify({ version: 1 }));
    await fs.chmod(cfgFile, 0o644);

    const { checkConfig } = await import("../src/commands/doctor.js");
    const r = await checkConfig();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/chmod 600/);
  });

  it("doctor checkConfig passes for a 0600 config", async () => {
    const cfgFile = path.join(tmp, "config.json");
    await fs.writeFile(cfgFile, JSON.stringify({ version: 1 }), { mode: 0o600 });
    await fs.chmod(cfgFile, 0o600);

    const { checkConfig } = await import("../src/commands/doctor.js");
    const r = await checkConfig();
    expect(r.ok).toBe(true);
  });
});
