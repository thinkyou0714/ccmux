import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execa } from "execa";

// I-050 (lite): `doctor` smoke. Spawns the real CLI via tsx and asserts doctor
// renders its table and never *crashes* — including when ~/.ccmux/config.json is
// present-and-valid and when it is present-but-invalid (doctor must degrade each
// dependent check gracefully and mark the config row ✘, not throw).
//
// Exit-code contract: doctor exits non-zero only when a *required* dependency is
// missing (the claude CLI). That CLI is NOT installed on the GitHub Actions
// runners, so we DON'T assert exit 0 — we assert doctor *ran and rendered its
// table without crashing* (exit code is a clean 0 or 1, never a crash) and pin
// the per-row behavior via stdout content instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const entry = path.join(repoRoot, "src", "index.ts");

const origEnv = { ...process.env };
let tmp: string;

function runDoctor() {
  return execa("npx", ["tsx", entry, "doctor"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CCMUX_DIR: path.join(tmp, ".ccmux"),
      HOME: tmp,
    },
    reject: false,
  });
}

async function writeConfig(body: string): Promise<void> {
  const dir = path.join(tmp, ".ccmux");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), body);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-doctor-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  process.env.HOME = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("doctor smoke (I-050 lite)", () => {
  it("renders the report header and core checks with no config present", async () => {
    const { exitCode, stdout } = await runDoctor();
    expect([0, 1]).toContain(exitCode); // 0 if claude present, 1 if not — both = "ran fine"
    expect(stdout).toContain("ccmux doctor");
    expect(stdout).toContain("Node.js");
  });

  it("does not crash with a valid config.json (config row reports OK)", async () => {
    await writeConfig(
      JSON.stringify({ version: 1, cost: { currency: "USD", exchangeRate: 1 } }),
    );
    const { exitCode, stdout } = await runDoctor();
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toContain("ccmux doctor");
    expect(stdout).toContain("config.json");
    // Valid config: the dedicated config check passes ("valid").
    expect(stdout).toMatch(/config\.json.*valid/);
  });

  it("does not crash with an invalid config.json (config row reports the error)", async () => {
    // EUR is not in the currency enum — loadConfig() rejects, and doctor must
    // surface that on the config row rather than letting it bubble up as a crash.
    await writeConfig(JSON.stringify({ cost: { currency: "EUR" } }));
    const { exitCode, stdout } = await runDoctor();
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toContain("ccmux doctor");
    expect(stdout).toContain("Node.js");
    expect(stdout).toMatch(/invalid config/i);
  });
});
