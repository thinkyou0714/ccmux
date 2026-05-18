import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const autoSrc = fileURLToPath(new URL("../src/commands/auto.ts", import.meta.url));
const indexSrc = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("H-04: --dangerously-skip-permissions is opt-in", () => {
  it("CLI registers --unsafe-skip-permissions with default false", async () => {
    const src = await fs.readFile(indexSrc, "utf-8");
    expect(src).toContain("--unsafe-skip-permissions");
    // The boolean option in commander uses (..., false) as the default.
    expect(src).toMatch(/--unsafe-skip-permissions[^,]*,[^,]*,\s*false\)/);
  });

  it("auto.ts has a dangerFlag() helper gating the danger flag", async () => {
    const src = await fs.readFile(autoSrc, "utf-8");
    expect(src).toContain("function dangerFlag");
    expect(src).toContain("opts.unsafeSkipPermissions");
  });

  it("--dangerously-skip-permissions only appears in conditional contexts", async () => {
    const src = await fs.readFile(autoSrc, "utf-8");
    // Strip comments — they reference the flag for documentation.
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // The old form was an UNconditional array literal:
    //   ["--dangerously-skip-permissions", "-p", `@${promptFile}`]
    // accept only inside conditional contexts.
    expect(stripped).not.toMatch(/\[\s*"--dangerously-skip-permissions"\s*,/);
    // No bare string concatenation against baseClaudeCmd either.
    expect(stripped).not.toMatch(/baseClaudeCmd\}\s+--dangerously-skip-permissions/);

    // Every remaining live-code occurrence must be paired with
    // unsafeSkipPermissions in the surrounding ~10 lines.
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("--dangerously-skip-permissions")) continue;
      const window = lines.slice(Math.max(0, i - 5), i + 5).join("\n");
      expect(window, `unconditional flag at line ${i + 1}: ${lines[i]}`).toMatch(
        /unsafeSkipPermissions|dangerFlag/,
      );
    }
  });

  it("zellij/tmux claudeCmd builds dangerSuffix from unsafeSkipPermissions", async () => {
    const src = await fs.readFile(autoSrc, "utf-8");
    expect(src).toContain("dangerSuffix");
    expect(src).toMatch(/opts\.unsafeSkipPermissions \? " --dangerously-skip-permissions" : ""/);
  });

  it("LoopDaemonOpts carries unsafeSkipPermissions through", async () => {
    const src = await fs.readFile(autoSrc, "utf-8");
    expect(src).toContain("unsafeSkipPermissions?: boolean");
    expect(src).toContain("unsafeSkipPermissions: opts.unsafeSkipPermissions");
  });
});
