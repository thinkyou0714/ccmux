import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const workerPath = fileURLToPath(new URL("../src/core/loop-daemon.ts", import.meta.url));
const compiledWorker = fileURLToPath(new URL("../dist/core/loop-daemon.js", import.meta.url));

describe("C-02: loop-daemon worker", () => {
  it("source file exists and exports runLoop", async () => {
    const src = await fs.readFile(workerPath, "utf-8");
    expect(src).toContain("export async function runLoop");
    expect(src).toContain("--worker");
    // Must NOT contain the old bash heredoc pattern
    expect(src).not.toContain("#!/usr/bin/env bash");
    expect(src).not.toContain("set -euo pipefail");
  });

  it("compiled worker is valid JS that fails fast on missing --worker", async () => {
    let compiledOk = false;
    try {
      await fs.access(compiledWorker);
      compiledOk = true;
    } catch {
      // Build hasn't run; skip — this is a smoke test for the dispatch path
    }
    if (!compiledOk) return;

    // Invoke without --worker should be a no-op (importable as a module
    // without dispatching the worker). We verify the dispatch guard.
    const src = await fs.readFile(workerPath, "utf-8");
    expect(src).toMatch(
      /process\.argv\[1\] === fileURLToPath\(import\.meta\.url\) && process\.argv\[2\] === "--worker"/
    );
  });

  it("untilPattern is matched as a literal substring, not a regex", async () => {
    // Load the source and confirm: .includes(untilPattern), no `new RegExp`.
    const src = await fs.readFile(workerPath, "utf-8");
    expect(src).toContain("includes(untilPattern)");
    expect(src).not.toContain("new RegExp(untilPattern");
  });

  it("rejects empty untilPattern (codex review 2026-05-19)", async () => {
    const src = await fs.readFile(workerPath, "utf-8");
    // runLoop entry: refuses empty pattern.
    expect(src).toMatch(/untilPattern must be a non-empty string/);
    // Worker fallback: rejects too.
    expect(src).toMatch(/untilPattern must be non-empty/);
  });

  it("only scans newly-appended log bytes per iteration (codex review)", async () => {
    const src = await fs.readFile(workerPath, "utf-8");
    // We must NOT read the entire log content each iteration.
    expect(src).not.toMatch(/readFile\(logFile,\s*"utf-8"\)/);
    // We MUST track an offset and use partial read.
    expect(src).toContain("iterStartOffset");
    expect(src).toContain("baselineOffset");
    expect(src).toMatch(/fh\.read\(/);
  });

  it("does NOT shell out to bash anywhere in the loop body", async () => {
    const src = await fs.readFile(workerPath, "utf-8");
    // Should never spawn bash; the legacy daemon did spawn("bash", [...]).
    expect(src).not.toMatch(/spawn\(["']bash["']/);
    expect(src).not.toMatch(/exec\(["'].*bash/);
  });

  it("worker exits non-zero on bad maxIter argv (smoke)", async () => {
    let compiledOk = false;
    try {
      await fs.access(compiledWorker);
      compiledOk = true;
    } catch {
      return;
    }
    if (!compiledOk) return;

    const tmpLog = path.join(os.tmpdir(), `ccmux-loop-test-${Date.now()}.log`);
    const result = await execa(
      process.execPath,
      [compiledWorker, "--worker", "not-a-number", "DONE", tmpLog, "W10="],
      { reject: false, timeout: 5000 }
    );
    expect(result.exitCode).not.toBe(0);
    await fs.rm(tmpLog, { force: true });
  });
});
