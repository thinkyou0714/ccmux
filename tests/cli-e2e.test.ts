import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { execa } from "execa";

// I-047: CLI end-to-end smoke. Spawns the *real* CLI (src/index.ts via tsx) so
// the commander wiring — version source, intArg coercions, session-name
// validation, --no-* option flags — is regression-pinned. Only fast-fail paths
// are exercised (no project/git fixture needed): each case fails before any
// session/worktree side effect, so a temp CCMUX_DIR is enough isolation and the
// spawns stay sub-second.

// Resolve repo root from this test file (tests/ -> repo root). Avoids relying on
// the worker cwd, which vitest does not guarantee to be the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const entry = path.join(repoRoot, "src", "index.ts");

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const origEnv = { ...process.env };
let tmp: string;

/** Run the CLI under tsx with an isolated CCMUX_DIR (and HOME, to avoid leaking
 *  the real ~/.ccmux). reject:false so we can assert on exitCode directly. */
function runCli(args: string[]) {
  return execa("npx", ["tsx", entry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CCMUX_DIR: path.join(tmp, ".ccmux"),
      HOME: tmp,
    },
    reject: false,
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-cli-e2e-"));
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");
  process.env.HOME = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CLI e2e smoke (I-047 — commander wiring regression)", () => {
  it("--version prints the package.json version (single source of truth)", async () => {
    const { exitCode, stdout } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("rejects a non-integer --lines (commander InvalidArgumentError)", async () => {
    const { exitCode, stderr } = await runCli(["logs", "x", "--lines", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/must be an integer/);
  });

  it("rejects a non-integer serve --port", async () => {
    const { exitCode, stderr } = await runCli(["serve", "--port", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid/);
    expect(stderr).toMatch(/must be/);
  });

  it("rejects an out-of-range serve --port", async () => {
    const { exitCode, stderr } = await runCli(["serve", "--port", "70000"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid/);
    expect(stderr).toMatch(/must be/);
  });

  it.each([
    ["traversal", "../evil"],
    ["whitespace", "a b"],
    ["empty", ""],
  ])("rejects an unsafe `new` name (%s)", async (_label, name) => {
    const { exitCode, stderr } = await runCli(["new", name]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid session name/);
  });

  it("close --help documents --no-handoff and --no-dashboard", async () => {
    const { exitCode, stdout } = await runCli(["close", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--no-handoff");
    expect(stdout).toContain("--no-dashboard");
  });
});
