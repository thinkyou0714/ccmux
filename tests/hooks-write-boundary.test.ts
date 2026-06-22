import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { installSessionHooks } from "../src/core/hooks.js";

// Exercises the real pre-tool-use.sh write boundary on POSIX. Windows is skipped:
// symlink creation needs privileges and git-bash path translation adds noise; the
// boundary logic is node-based and platform-independent, fully covered here.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

let base: string; // parent dir, for building sibling / outside paths
let tmp: string; // the worktree
let outside: string; // a dir fully outside the worktree
let hookPath: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wb-"));
  tmp = path.join(base, "wt");
  outside = path.join(base, "outside");
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await installSessionHooks(tmp, "wt", 50);
  hookPath = path.join(tmp, ".claude", "hooks", "pre-tool-use.sh");
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function writeHook(filePath: string): number {
  const r = spawnSync("bash", [hookPath], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } }),
    encoding: "utf-8",
    env: { ...process.env },
  });
  return r.status ?? 1;
}

posixOnly("SEC-07: write-boundary canonicalization", () => {
  it("allows a write inside the worktree", () => {
    expect(writeHook(path.join(tmp, "src", "file.ts"))).toBe(0);
  });

  it("allows a write to a file at the worktree root", () => {
    expect(writeHook(path.join(tmp, "file.ts"))).toBe(0);
  });

  it("blocks a sibling dir that merely shares the worktree's string prefix", () => {
    // <base>/wt-evil/x — the old `${path#$WORKTREE}` prefix check let this through.
    expect(writeHook(path.join(base, "wt-evil", "x.ts"))).toBe(2);
  });

  it("blocks a ../ traversal that escapes the worktree", () => {
    // Built by concatenation so the literal ".." survives to the hook (path.join
    // would normalize it away before the hook ever sees it).
    expect(writeHook(`${tmp}/../outside/escape.txt`)).toBe(2);
  });

  it("blocks an absolute path outside the worktree", () => {
    expect(writeHook("/etc/passwd")).toBe(2);
  });

  it("blocks a write through an outward symlink inside the worktree", async () => {
    // <wt>/outlink -> <outside>; writing <wt>/outlink/p.txt lands outside.
    await fs.symlink(outside, path.join(tmp, "outlink"), "dir");
    expect(writeHook(path.join(tmp, "outlink", "p.txt"))).toBe(2);
  });

  it("still allows a deep real subdirectory write", () => {
    expect(writeHook(path.join(tmp, "real", "deep", "p.txt"))).toBe(0);
  });
});
