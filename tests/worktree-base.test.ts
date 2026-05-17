import { describe, it, expect, afterEach } from "vitest";
import { resolveWorktreeBase } from "../src/core/worktree.js";

describe("resolveWorktreeBase (BL-B1)", () => {
  const origEnv = process.env.CCMUX_WORKTREE_BASE;
  const origHome = process.env.HOME;

  afterEach(() => {
    process.env.CCMUX_WORKTREE_BASE = origEnv;
    process.env.HOME = origHome;
  });

  it("uses explicit override above env and default", () => {
    process.env.CCMUX_WORKTREE_BASE = "/from-env";
    process.env.HOME = "/from-home";
    expect(resolveWorktreeBase("/from-arg")).toBe("/from-arg");
  });

  it("falls through to CCMUX_WORKTREE_BASE env when no override", () => {
    process.env.CCMUX_WORKTREE_BASE = "/from-env";
    process.env.HOME = "/from-home";
    expect(resolveWorktreeBase()).toBe("/from-env");
  });

  it("falls through to ${HOME}/worktrees when neither is set", () => {
    delete process.env.CCMUX_WORKTREE_BASE;
    process.env.HOME = "/home/test";
    expect(resolveWorktreeBase()).toBe("/home/test/worktrees");
  });

  it("uses USERPROFILE when HOME is unset (Windows fallback)", () => {
    delete process.env.CCMUX_WORKTREE_BASE;
    delete process.env.HOME;
    process.env.USERPROFILE = "C:/Users/test";
    try {
      expect(resolveWorktreeBase()).toBe("C:/Users/test/worktrees");
    } finally {
      delete process.env.USERPROFILE;
    }
  });
});
