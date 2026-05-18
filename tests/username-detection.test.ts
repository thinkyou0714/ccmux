import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const srcPath = fileURLToPath(new URL("../src/core/cost.ts", import.meta.url));

describe("H-05: cost.ts username resolution", () => {
  it("no live code references 'Rikuto' as a fallback value", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    // Strip line comments first — the H-05 docstring legitimately mentions
    // the historical literal to explain why it's gone.
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toContain('"Rikuto"');
    expect(stripped).not.toContain("'Rikuto'");
  });

  it("derives username from USERPROFILE first", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toContain("process.env.USERPROFILE");
    expect(src).toContain("WINDOWS_USERNAME");
    expect(src).toContain("USERNAME");
    expect(src).toContain("USER");
  });

  it("explicit CLAUDE_CONFIG_DIR override is checked at the top of resolveClaudeConfigDir", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    // Extract the body of resolveClaudeConfigDir and check that
    // CLAUDE_CONFIG_DIR appears before any call to resolveWindowsUsername.
    const fnMatch = src.match(/function resolveClaudeConfigDir\([^)]*\)[^{]*{([\s\S]*?)\n}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];
    const overrideIdx = body.indexOf("CLAUDE_CONFIG_DIR");
    const winUserCallIdx = body.indexOf("resolveWindowsUsername(");
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(winUserCallIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(winUserCallIdx);
  });
});
