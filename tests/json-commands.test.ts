import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execa } from "execa";

// I-099: command-level --json smoke. Two strategies:
//   - prune: called in-process against an isolated, empty CCMUX_DIR so it hits
//     the "no orphaned sessions" branch (no git/worktree/spawn needed) and we
//     assert the envelope shape on stdout.
//   - doctor: spawned via the real CLI (its checks shell out to external CLIs),
//     asserting only that ONE valid envelope lands on stdout and the exit code
//     is a clean 0/1 — never asserting exit 0, since the required `claude` CLI
//     is absent on CI runners (mirrors doctor-smoke.test.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const entry = path.join(repoRoot, "src", "index.ts");

const origEnv = { ...process.env };
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-json-cmd-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

// prune calls execa("ccusage") nowhere, but listSessions stays pure here; keep
// the in-process call off Windows for parity with the other wrapper tests.
const describePrune = process.platform === "win32" ? describe.skip : describe;

describePrune("prune --json", () => {
  it("emits an OK envelope with removed:0 when there are no orphans", async () => {
    const { pruneCommand } = await import("../src/commands/prune.js");
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      await pruneCommand({ json: true });
    } finally {
      spy.mockRestore();
    }
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.error).toBeNull();
    expect(parsed.meta.command).toBe("prune");
    expect(parsed.data).toMatchObject({ removed: 0, candidates: [], skipped: [], dryRun: false });
  });

  it("--dry-run --json reports dryRun:true and removes nothing", async () => {
    const { pruneCommand } = await import("../src/commands/prune.js");
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      await pruneCommand({ json: true, dryRun: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out);
    expect(parsed.data.dryRun).toBe(true);
    expect(parsed.data.removed).toBe(0);
  });
});

describe("doctor --json", () => {
  it("prints exactly one valid envelope and exits cleanly (0 or 1)", async () => {
    const { exitCode, stdout } = await execa("npx", ["tsx", entry, "doctor", "--json"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CCMUX_DIR: path.join(tmp, ".ccmux"),
        HOME: tmp,
      },
      reject: false,
    });
    // claude CLI absence => exit 1; presence => 0. Both mean "ran fine".
    expect([0, 1]).toContain(exitCode);
    // Exactly one envelope line on stdout (human table is suppressed in --json).
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.error).toBeNull();
    expect(parsed.meta.command).toBe("doctor");
    expect(Array.isArray(parsed.data.checks)).toBe(true);
    // The Node.js version check is always present.
    expect(parsed.data.checks.some((c: { label: string }) => c.label.startsWith("Node.js"))).toBe(true);
    // ok/criticalFail are booleans and mutually consistent.
    expect(typeof parsed.data.ok).toBe("boolean");
    expect(parsed.data.ok).toBe(!parsed.data.criticalFail);
  });
});
