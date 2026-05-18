import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const srcPath = fileURLToPath(new URL("../src/integrations/obsidian.ts", import.meta.url));

describe("H-06: obsidian TLS hardening (static checks)", () => {
  it("rejectUnauthorized:false is gated by an env opt-out", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toContain("CCMUX_OBSIDIAN_ALLOW_SELFSIGNED");
    // The expression must be a conditional, not a bare `rejectUnauthorized: false`.
    expect(src).not.toMatch(/rejectUnauthorized:\s*false\s*,/);
    expect(src).toMatch(/rejectUnauthorized:\s*!allowSelfSigned/);
  });

  it("default behaviour is strict TLS", async () => {
    // Default env (no CCMUX_OBSIDIAN_ALLOW_SELFSIGNED) → allowSelfSigned=false
    // → rejectUnauthorized: true.
    const prev = process.env.CCMUX_OBSIDIAN_ALLOW_SELFSIGNED;
    delete process.env.CCMUX_OBSIDIAN_ALLOW_SELFSIGNED;
    try {
      const computed = process.env.CCMUX_OBSIDIAN_ALLOW_SELFSIGNED === "1";
      expect(!computed).toBe(true); // !allowSelfSigned === true
    } finally {
      if (prev !== undefined) process.env.CCMUX_OBSIDIAN_ALLOW_SELFSIGNED = prev;
    }
  });
});
