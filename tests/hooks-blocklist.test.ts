import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

let tmp: string;
let hookPath: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-hooks-test-"));
  await installSessionHooks(tmp, "test-session", 50);
  hookPath = path.join(tmp, ".claude", "hooks", "pre-tool-use.sh");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function runHook(
  input: object,
  env: Record<string, string> = {},
): { exitCode: number; stderr: string } {
  const r = spawnSync("bash", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? "" };
}

const bashEvt = (cmd: string) => ({
  tool_name: "Bash",
  tool_input: { command: cmd },
});

describe("BL-2: destructive Bash blocklist", () => {
  it("blocks drizzle-kit push --force", () => {
    const r = runHook(bashEvt("drizzle-kit push --force"));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/destructive command blocked/);
  });

  it("blocks DROP TABLE in psql -c", () => {
    const r = runHook(bashEvt(`psql -c "DROP TABLE users"`));
    expect(r.exitCode).toBe(2);
  });

  it("blocks rm -rf / and rm -rf ~", () => {
    expect(runHook(bashEvt("rm -rf /")).exitCode).toBe(2);
    expect(runHook(bashEvt("rm -rf ~")).exitCode).toBe(2);
    expect(runHook(bashEvt("rm -rf --no-preserve-root /")).exitCode).toBe(2);
  });

  it("blocks git push --force and git push -f", () => {
    expect(runHook(bashEvt("git push --force origin main")).exitCode).toBe(2);
    expect(runHook(bashEvt("git push -f origin main")).exitCode).toBe(2);
  });

  it("blocks docker compose up -d prod", () => {
    expect(runHook(bashEvt("docker compose up -d prod")).exitCode).toBe(2);
    expect(runHook(bashEvt("docker up -d production")).exitCode).toBe(2);
  });

  it("blocks credentials exfiltration via cat .env / credentials", () => {
    expect(runHook(bashEvt("cat .env")).exitCode).toBe(2);
    expect(runHook(bashEvt("cat ~/.aws/credentials")).exitCode).toBe(2);
    expect(runHook(bashEvt("cat ~/.ssh/id_rsa")).exitCode).toBe(2);
  });

  it("blocks supabase db reset", () => {
    expect(runHook(bashEvt("supabase db reset")).exitCode).toBe(2);
  });

  it("allows safe commands", () => {
    expect(runHook(bashEvt("ls -la")).exitCode).toBe(0);
    expect(runHook(bashEvt("git status")).exitCode).toBe(0);
    expect(runHook(bashEvt("npm test")).exitCode).toBe(0);
    expect(runHook(bashEvt("rm file.txt")).exitCode).toBe(0); // not -rf /
  });

  it("allows when CCMUX_BLOCKLIST_OVERRIDE=1 is set", () => {
    const r = runHook(bashEvt("git push --force origin main"), {
      CCMUX_BLOCKLIST_OVERRIDE: "1",
    });
    expect(r.exitCode).toBe(0);
  });
});
