import { describe, it, expect } from "vitest";
import { validateSessionName } from "../src/core/worktree.js";

// validateSessionName is the CWE-22 guard at the top of createWorktree/
// deleteWorktree and both /session/* handlers. It is exercised indirectly by
// the worktree + n8n-handler suites; this pins its contract directly.
describe("validateSessionName", () => {
  it("accepts conventional names", () => {
    for (const ok of ["feature", "fix-bug", "issue-42", "a.b_c", "team/task", "UPPER123"]) {
      expect(() => validateSessionName(ok)).not.toThrow();
    }
  });

  it("rejects empty and over-long names", () => {
    expect(() => validateSessionName("")).toThrow();
    expect(() => validateSessionName("a".repeat(129))).toThrow();
  });

  it("rejects path traversal and absolute paths", () => {
    for (const bad of ["../escape", "a/../b", "..", "a/..", "/etc/passwd", "./x"]) {
      expect(() => validateSessionName(bad)).toThrow();
    }
  });

  it("rejects a leading dash (git option injection)", () => {
    expect(() => validateSessionName("-rf")).toThrow();
    expect(() => validateSessionName("--force")).toThrow();
  });

  it("rejects characters outside the safe charset", () => {
    for (const bad of ["a b", "a;b", "a$b", "a|b", "a\\b", "a\nb", "a*b"]) {
      expect(() => validateSessionName(bad)).toThrow();
    }
  });
});
