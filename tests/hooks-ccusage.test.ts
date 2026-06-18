import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

// MSYS / Git Bash on Windows cannot exec extension-less shell scripts on PATH,
// so the fake ccusage shim won't be found by the hook. Linux + macOS resolve
// it normally; CI (ubuntu-latest) exercises the real code path.
const skipOnWindows = process.platform === "win32" ? describe.skip : describe;

let tmp: string;
let binDir: string;
let stopHook: string;
const origCcmuxDir = process.env.CCMUX_DIR;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-ccusage-test-"));
  binDir = path.join(tmp, "bin");
  await fs.mkdir(binDir, { recursive: true });
  // Isolate the Stop hook's circuit-breaker log (CCMUX_DIR/circuit, I-029) to
  // this temp dir so an accumulated shared ~/.ccmux/circuit can't pre-trip the
  // breaker and short-circuit the hook before the ccusage cost capture runs.
  process.env.CCMUX_DIR = path.join(tmp, ".ccmux");

  // Fake `ccusage` shim that always returns a known cost.
  const shim = path.join(binDir, "ccusage");
  await fs.writeFile(
    shim,
    `#!/usr/bin/env bash
# Test shim: returns 1.23 for any input.
echo "1.23"
`,
    { mode: 0o755 },
  );
  // Also create a .cmd version so Windows-launched bash that resolves via cmd.exe finds it.
  await fs.writeFile(path.join(binDir, "ccusage.cmd"), '@echo 1.23\n');

  await installSessionHooks(tmp, "ccusage-test", 50);
  stopHook = path.join(tmp, ".claude", "hooks", "stop.sh");
});

afterAll(async () => {
  if (origCcmuxDir === undefined) delete process.env.CCMUX_DIR;
  else process.env.CCMUX_DIR = origCcmuxDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

function fire(input: object): { code: number; stderr: string } {
  const r = spawnSync("bash", [stopHook], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
}

skipOnWindows("BL-4: ccusage cost capture in Stop hook", () => {
  it("inserts a Cost line into TASK_STATE.md when ccusage and session_id are available", async () => {
    const tsFile = path.join(tmp, "TASK_STATE.md");
    await fs.writeFile(
      tsFile,
      [
        "# TASK_STATE",
        "",
        "- **Session**: ccusage-test",
        "- **Status**: running",
        "- **Iteration**: 0 / 50",
        "- **Last Updated**: 2026-05-17T00:00:00Z",
        "",
        "## Goal",
        "",
        "x",
        "",
        "## Next Steps",
        "",
        "- [ ] keep going",
        "",
      ].join("\n"),
      "utf-8",
    );

    fire({ session_id: "test-session-xyz", stop_hook_active: false });

    const after = await fs.readFile(tsFile, "utf-8");
    expect(after).toMatch(/^- \*\*Cost\*\*: \$1\.23 USD$/m);
    // The Cost line should appear above Last Updated, preserving the existing line.
    const costIdx = after.indexOf("- **Cost**:");
    const luIdx = after.indexOf("- **Last Updated**:");
    expect(costIdx).toBeGreaterThanOrEqual(0);
    expect(luIdx).toBeGreaterThan(costIdx);
  });

  it("updates an existing Cost line rather than appending", async () => {
    const tsFile = path.join(tmp, "TASK_STATE.md");
    await fs.writeFile(
      tsFile,
      [
        "- **Cost**: $0.00 USD",
        "- **Last Updated**: 2026-05-17T00:00:00Z",
      ].join("\n"),
      "utf-8",
    );

    fire({ session_id: "test-session-xyz", stop_hook_active: false });

    const after = await fs.readFile(tsFile, "utf-8");
    // Only ONE Cost line, and it carries the new value.
    const matches = after.match(/^- \*\*Cost\*\*:/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(after).toMatch(/\$1\.23 USD/);
  });

  it("silently skips when CCMUX_DISABLE_CCUSAGE=1 is set", async () => {
    const tsFile = path.join(tmp, "TASK_STATE.md");
    await fs.writeFile(
      tsFile,
      "- **Last Updated**: 2026-05-17T00:00:00Z\n",
      "utf-8",
    );

    spawnSync("bash", [stopHook], {
      input: JSON.stringify({ session_id: "x", stop_hook_active: false }),
      encoding: "utf-8",
      env: {
        ...process.env,
        CCMUX_DISABLE_CCUSAGE: "1",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    const after = await fs.readFile(tsFile, "utf-8");
    expect(after).not.toMatch(/Cost/);
  });
});
