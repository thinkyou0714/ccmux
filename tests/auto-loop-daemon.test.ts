import { describe, it, expect } from "vitest";
import {
  buildLoopDaemonScript,
  assertLoopValueSafe,
  isSandboxAvailable,
} from "../src/commands/auto.js";

describe("SEC-06: loop daemon script generation", () => {
  const script = buildLoopDaemonScript(`"claude" "-p" "@/wt/TASK_PROMPT.md"`);

  it("reads run parameters from the environment, not from interpolated script text", () => {
    // The --until pattern, log path, and iteration cap arrive via CCMUX_LOOP_*
    // env vars (`:?` aborts if unset) — never string-interpolated, so there is
    // no shell-quoting dependency for those values.
    expect(script).toContain('MAX_ITER="${CCMUX_LOOP_MAX_ITER:?}"');
    expect(script).toContain('UNTIL_PATTERN="${CCMUX_LOOP_UNTIL:?}"');
    expect(script).toContain('LOGFILE="${CCMUX_LOOP_LOGFILE:?}"');
  });

  it("interpolates only the already-shell-quoted claude invocation", () => {
    expect(script).toContain(`"claude" "-p" "@/wt/TASK_PROMPT.md"`);
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("CCMUX_LOOP_COMPLETE");
    expect(script).toContain("CCMUX_LOOP_MAX_ITER_REACHED");
  });
});

describe("SEC-06: assertLoopValueSafe", () => {
  it("accepts ordinary values (incl. multi-byte unicode)", () => {
    expect(() => assertLoopValueSafe("--until", "CCMUX_COMPLETE")).not.toThrow();
    expect(() => assertLoopValueSafe("log path", "/home/u/.ccmux/logs/issue-1.log")).not.toThrow();
    expect(() => assertLoopValueSafe("--until", "done 100% ✓")).not.toThrow();
  });

  it("rejects newline / CR / NUL / ESC control characters", () => {
    expect(() => assertLoopValueSafe("--until", "foo\nrm -rf /")).toThrow(/control character/);
    expect(() => assertLoopValueSafe("--until", "foo\rbar")).toThrow(/control character/);
    expect(() => assertLoopValueSafe("log path", "a\x00b")).toThrow(/control character/);
    expect(() => assertLoopValueSafe("--until", "a\x1bb")).toThrow(/control character/);
  });
});

describe("SEC-04: isSandboxAvailable", () => {
  it("resolves to a boolean without throwing", async () => {
    expect(typeof (await isSandboxAvailable())).toBe("boolean");
  });

  it("is false on non-Linux hosts (sandbox requires bubblewrap on Linux)", async () => {
    if (process.platform === "linux") return; // off-Linux contract only
    expect(await isSandboxAvailable()).toBe(false);
  });
});
