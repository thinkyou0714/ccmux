import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

let tmp: string;
let stopHook: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-circuit-test-"));
  await installSessionHooks(tmp, "test-circuit", 50);
  stopHook = path.join(tmp, ".claude", "hooks", "stop.sh");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function fire(input: object, env: Record<string, string> = {}): { code: number; stderr: string } {
  const r = spawnSync("bash", [stopHook], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
}

describe("BL-3: Stop hook circuit breaker", () => {
  it("trips after >= CCMUX_CIRCUIT_FIRES fires within window", async () => {
    // Fresh log
    await fs.rm(path.join(tmp, ".ccmux-circuit.log"), { force: true });

    // Drop TASK_STATE so the hook would normally block (status running, no completion).
    await fs.writeFile(
      path.join(tmp, "TASK_STATE.md"),
      `# TASK_STATE\n\n- **Session**: test\n- **Status**: running\n- **Iteration**: 0 / 50\n- **Last Updated**: now\n\n## Goal\n\nx\n\n## Completed Steps\n\n_(none)_\n\n## Next Steps\n\n- [ ] keep going\n`,
      "utf-8"
    );

    // First 2 fires should block (exit 2) — task not complete, no circuit trip yet.
    const env = { CCMUX_CIRCUIT_FIRES: "3", CCMUX_CIRCUIT_WINDOW_SEC: "60" };
    expect(fire({ stop_hook_active: false }, env).code).toBe(2);
    expect(fire({ stop_hook_active: false }, env).code).toBe(2);

    // 3rd fire trips circuit and allows stop.
    const tripped = fire({ stop_hook_active: false }, env);
    expect(tripped.code).toBe(0);
    expect(tripped.stderr).toMatch(/circuit breaker tripped/);
  });

  it("allows stop immediately on context-limit pattern", () => {
    const r = fire({
      stop_hook_active: false,
      error: { message: "context_length_exceeded: prompt is too long" },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/context-limit signal detected/);
  });

  it("still respects stop_hook_active guard (existing behavior)", () => {
    const r = fire({ stop_hook_active: true });
    expect(r.code).toBe(0);
  });
});
