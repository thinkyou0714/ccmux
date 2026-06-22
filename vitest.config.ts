import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many suites spawn real git/bash subprocesses (worktree create/remove,
    // Stop/PreToolUse hook scripts). On overloaded Windows CI runners those
    // spawns can blow past vitest's default 5s timeout, producing flaky
    // timeout cascades that have nothing to do with the code under test
    // (observed: a run where the whole suite took ~200s instead of ~10s).
    // Give them generous headroom — a genuinely hung test still fails, later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
