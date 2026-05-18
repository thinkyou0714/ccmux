import { describe, it, expect } from "vitest";
import type { CcmuxConfig } from "../src/config/schema.js";
import {
  buildAutoClaudeArgs,
  buildAutoClaudeCommand,
  buildLaunchArgs,
  buildShellInvocation,
} from "../src/commands/auto.js";

function cfg(model?: string): CcmuxConfig {
  return {
    version: 1,
    worktreeBase: "/tmp/worktrees",
    zellijSession: "lab",
    defaultProject: "repo",
    projects: {
      repo: { path: "/repo", defaultLlm: "autoclaw" },
    },
    n8n: { enabled: false, webhookUrl: "", servePort: 9090 },
    obsidian: { enabled: false, baseUrl: "", apiKey: "", handoffPath: "" },
    autoclaw: { url: "http://127.0.0.1:3101/task", model },
    cost: { enabled: false, currency: "USD", exchangeRate: 1 },
    logs: { maxAgeDays: 30, maxSizeMB: 100 },
  };
}

describe("auto command claude argument generation", () => {
  it("passes the autoclaw model through the Zellij command path", () => {
    const command = buildAutoClaudeCommand("autoclaw", cfg("qwen3-coder"), [
      "--dangerously-skip-permissions",
    ]);

    expect(command).toBe(
      'ANTHROPIC_BASE_URL="http://127.0.0.1:3101/task" "claude" "--model" "qwen3-coder" "--dangerously-skip-permissions"'
    );
  });

  it("passes the autoclaw model through the single-shot daemon launch path", () => {
    const claudeArgs = buildAutoClaudeArgs("autoclaw", cfg("qwen3-coder"), [
      "--dangerously-skip-permissions",
      "-p",
      "@/repo/TASK_PROMPT.md",
    ]);
    const launch = buildLaunchArgs(claudeArgs, "/repo", false);

    expect(launch).toEqual({
      bin: "claude",
      args: [
        "--model",
        "qwen3-coder",
        "--dangerously-skip-permissions",
        "-p",
        "@/repo/TASK_PROMPT.md",
      ],
    });
  });

  it("passes the autoclaw model through the loop daemon invocation path", () => {
    const claudeArgs = buildAutoClaudeArgs("autoclaw", cfg("qwen3-coder"), [
      "--dangerously-skip-permissions",
      "-p",
      "@/repo/TASK_PROMPT.md",
    ]);
    const launch = buildLaunchArgs(claudeArgs, "/repo", true);
    const invocation = buildShellInvocation(launch.bin, launch.args);

    expect(launch.bin).toBe("bwrap");
    expect(invocation).toContain('"claude" "--model" "qwen3-coder" "--dangerously-skip-permissions"');
  });

  it("does not add a model for claude backend or unset autoclaw model", () => {
    expect(buildAutoClaudeArgs("claude", cfg("qwen3-coder"), ["--dangerously-skip-permissions"])).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(buildAutoClaudeArgs("autoclaw", cfg(), ["--dangerously-skip-permissions"])).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });
});
