import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const srcPath = fileURLToPath(new URL("../src/core/zellij.ts", import.meta.url));

describe("C-01: zellij/tmux send safety (static checks)", () => {
  it("tmux path uses load-buffer + paste-buffer, not bare send-keys with prompt", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toContain('"load-buffer"');
    expect(src).toContain('"paste-buffer"');
    // The bare send-keys with arbitrary prompt+Enter pattern must be gone.
    expect(src).not.toMatch(/"send-keys"[^]*?"-t"[^]*?tabName[^]*?,\s*prompt\b/);
  });

  it("zellij write-chars runs prompt through stripCtrl", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toContain("stripCtrl(prompt)");
    expect(src).toContain("stripCtrl(command)");
  });

  it("stripCtrl regex preserves TAB and LF but drops other ASCII control", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    // Match the regex literal used in stripCtrl
    const m = src.match(/replace\((\/\[[^\]]+\]\/g)/);
    expect(m).not.toBeNull();
    const regexStr = m![1];
    expect(regexStr).toContain("\\x00-\\x08"); // through BS
    expect(regexStr).toContain("\\x0B");        // VT
    expect(regexStr).toContain("\\x0C");        // FF
    expect(regexStr).toContain("\\x0E-\\x1F"); // SO through US
    expect(regexStr).toContain("\\x7F");        // DEL
    // Importantly, \x09 (TAB) and \x0A (LF) are NOT in the class.
    expect(regexStr).not.toContain("\\x09");
    expect(regexStr).not.toContain("\\x0A");
  });

  it("buffer name is unique enough to avoid races (timestamp + random)", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toMatch(/ccmux-\$\{Date\.now\(\)\}-\$\{Math\.random/);
  });
});
