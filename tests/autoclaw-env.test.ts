import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildClaudeEnv } from "../src/integrations/autoclaw.js";
import type { CcmuxConfig } from "../src/config/schema.js";

// Minimal config stub — buildClaudeEnv only reads cfg.autoclaw.{url,authToken}.
function cfg(overrides?: Partial<CcmuxConfig["autoclaw"]>): CcmuxConfig {
  return {
    autoclaw: { url: "http://localhost:11434", ...overrides },
  } as unknown as CcmuxConfig;
}

const CLOUD_VARS = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
];

const origEnv = { ...process.env };

beforeEach(() => {
  for (const v of CLOUD_VARS) process.env[v] = `secret-${v}`;
  process.env["PATH"] = process.env["PATH"] ?? "/usr/bin";
  process.env["HOME"] = process.env["HOME"] ?? "/home/test";
  // The test runner's own env may set ANTHROPIC_BASE_URL; clear it so we can
  // assert the claude backend does not inject the autoclaw URL.
  delete process.env["ANTHROPIC_BASE_URL"];
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("I-089 buildClaudeEnv credential minimisation", () => {
  it("strips cloud credentials for the autoclaw (local LLM) backend", () => {
    const env = buildClaudeEnv("autoclaw", cfg(), "sess-1");
    for (const v of CLOUD_VARS) {
      expect(env[v], `${v} must not leak to local-LLM child`).toBeUndefined();
    }
  });

  it("preserves non-credential env (PATH/HOME) and sets ANTHROPIC_BASE_URL for autoclaw", () => {
    const env = buildClaudeEnv("autoclaw", cfg(), "sess-2");
    expect(env["PATH"]).toBeDefined();
    expect(env["HOME"]).toBeDefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://localhost:11434");
    expect(env["CCMUX_SESSION"]).toBe("sess-2");
  });

  it("uses the configured local proxy token (not an inherited cloud key) as ANTHROPIC_AUTH_TOKEN", () => {
    // Even though ANTHROPIC_API_KEY is in the parent env, the only auth token
    // handed to the child is the local proxy token from config.
    const env = buildClaudeEnv("autoclaw", cfg({ authToken: "ollama" }), "sess-3");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("ollama");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("does NOT strip credentials for the cloud claude backend (unchanged behaviour)", () => {
    const env = buildClaudeEnv("claude", cfg(), "sess-4");
    expect(env["ANTHROPIC_API_KEY"]).toBe("secret-ANTHROPIC_API_KEY");
    expect(env["GITHUB_TOKEN"]).toBe("secret-GITHUB_TOKEN");
    // No autoclaw base URL injected for the cloud backend.
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });
});
