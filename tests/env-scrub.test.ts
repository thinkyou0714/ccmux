import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scrubEnv, _allowedKeysForTest } from "../src/core/env-scrub.js";

describe("C-03/H-02: scrubEnv", () => {
  const originals: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined): void {
    if (!(key in originals)) originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(originals)) delete originals[k];
  });

  it("does NOT leak ANTHROPIC_API_KEY into the scrubbed env", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-ant-secret-do-not-leak");
    const env = scrubEnv();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("does NOT leak AWS_SESSION_TOKEN", () => {
    setEnv("AWS_SESSION_TOKEN", "AKIA-something-very-secret");
    const env = scrubEnv();
    expect(env).not.toHaveProperty("AWS_SESSION_TOKEN");
  });

  it("does NOT leak OBSIDIAN_API_KEY", () => {
    setEnv("OBSIDIAN_API_KEY", "a".repeat(64));
    const env = scrubEnv();
    expect(env).not.toHaveProperty("OBSIDIAN_API_KEY");
  });

  it("does NOT leak GITHUB_TOKEN", () => {
    setEnv("GITHUB_TOKEN", "ghp_secret");
    const env = scrubEnv();
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("PATH is passed through", () => {
    setEnv("PATH", "/usr/local/bin:/usr/bin");
    expect(scrubEnv()).toHaveProperty("PATH", "/usr/local/bin:/usr/bin");
  });

  it("HOME is passed through when set", () => {
    setEnv("HOME", "/home/test");
    expect(scrubEnv()).toHaveProperty("HOME", "/home/test");
  });

  it("CCMUX_SESSION from extra wins over scrubbed parent", () => {
    setEnv("CCMUX_SESSION", "parent-session");
    const env = scrubEnv({ CCMUX_SESSION: "child-session" });
    expect(env.CCMUX_SESSION).toBe("child-session");
  });

  it("extra values land in the result", () => {
    const env = scrubEnv({ ANTHROPIC_BASE_URL: "http://localhost:4101" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4101");
  });

  it("allowlist does NOT include obviously sensitive keys", () => {
    const allowed = new Set(_allowedKeysForTest());
    const forbidden = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "OBSIDIAN_API_KEY",
      "STRIPE_SECRET_KEY",
      "DATABASE_URL",
    ];
    for (const k of forbidden) {
      expect(allowed.has(k), `${k} should not be in allowlist`).toBe(false);
    }
  });

  it("allowlist does NOT include Node code-injection env vars (codex review)", () => {
    // NODE_OPTIONS="--require /tmp/evil.js" gives the child a remote code
    // execution primitive; NODE_PATH redirects module resolution;
    // NPM_CONFIG_USERCONFIG points npm at an attacker-controlled .npmrc.
    const allowed = new Set(_allowedKeysForTest());
    for (const k of ["NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_USERCONFIG"]) {
      expect(allowed.has(k), `${k} must not be in allowlist (RCE vector)`).toBe(false);
    }
  });

  it("does not include keys whose values are undefined in process.env", () => {
    setEnv("CCMUX_SESSION", undefined);
    const env = scrubEnv();
    expect(env).not.toHaveProperty("CCMUX_SESSION");
  });
});
