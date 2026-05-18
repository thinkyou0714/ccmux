import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const srcPath = fileURLToPath(new URL("../src/integrations/n8n.ts", import.meta.url));

describe("H-03: n8n authToken hardening (static + runtime checks)", () => {
  const originals: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string | undefined): void {
    if (!(key in originals)) originals[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(originals)) delete originals[k];
  });

  it("checkAuth no longer returns true on missing authToken", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    // Strip comments so a historical reference in a docstring doesn't match.
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/if\s*\(\s*!authToken\s*\)\s*return\s+true/);
    expect(stripped).toContain("crypto.timingSafeEqual");
  });

  it("startServer throws when authToken is unset and no env opt-out", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toContain("CCMUX_N8N_ALLOW_NOAUTH");
    expect(src).toMatch(/throw new Error\(\s*[`"']n8n\.authToken is required/);
  });

  it("the opt-out env var is documented near the throw", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    // The flow: rawAuthToken? -> CCMUX_N8N_ALLOW_NOAUTH=1? -> throw
    const idx = src.indexOf("n8n.authToken is required");
    expect(idx).toBeGreaterThan(0);
    const optOut = src.indexOf("CCMUX_N8N_ALLOW_NOAUTH");
    expect(optOut).toBeGreaterThan(0);
    expect(optOut).toBeLessThan(idx); // checked before the throw
  });

  it("CCMUX_N8N_ALLOW_NOAUTH=1 surfaces a loud WARNING", async () => {
    const src = await fs.readFile(srcPath, "utf-8");
    expect(src).toMatch(/console\.warn\([^)]*CCMUX_N8N_ALLOW_NOAUTH/);
  });
});
