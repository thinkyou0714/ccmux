import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { applyWorktreeInclude } from "../src/core/worktree.js";

let proj: string;
let wt: string;

beforeEach(async () => {
  proj = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wti-src-"));
  wt = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wti-dst-"));
});

afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true });
  await fs.rm(wt, { recursive: true, force: true });
});

describe("applyWorktreeInclude (BL-B2)", () => {
  it("returns empty result when .worktreeinclude is missing", async () => {
    const r = await applyWorktreeInclude(proj, wt);
    expect(r.copied).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("copies listed files to the worktree at the same relative path", async () => {
    await fs.writeFile(path.join(proj, ".env"), "SECRET=1");
    await fs.mkdir(path.join(proj, ".vscode"), { recursive: true });
    await fs.writeFile(path.join(proj, ".vscode/settings.json"), '{"editor":"vim"}');
    await fs.writeFile(path.join(proj, ".worktreeinclude"), `# comments are skipped
.env

.vscode/settings.json
`);

    const r = await applyWorktreeInclude(proj, wt);
    expect(r.copied.sort()).toEqual([".env", ".vscode/settings.json"]);
    expect(r.missing).toEqual([]);

    expect(await fs.readFile(path.join(wt, ".env"), "utf-8")).toBe("SECRET=1");
    expect(await fs.readFile(path.join(wt, ".vscode/settings.json"), "utf-8")).toBe(
      '{"editor":"vim"}'
    );
  });

  it("records missing files but does not throw", async () => {
    await fs.writeFile(path.join(proj, ".env"), "X=1");
    await fs.writeFile(
      path.join(proj, ".worktreeinclude"),
      ".env\nnonexistent.json\n"
    );

    const r = await applyWorktreeInclude(proj, wt);
    expect(r.copied).toEqual([".env"]);
    expect(r.missing).toEqual(["nonexistent.json"]);
  });

  it("skips comment-only and blank entries cleanly", async () => {
    await fs.writeFile(path.join(proj, ".worktreeinclude"), "\n# nothing here\n\n");
    const r = await applyWorktreeInclude(proj, wt);
    expect(r.copied).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("refuses path-traversal entries so the write stays inside the worktree", async () => {
    // Isolated bases so `..` from the project and the worktree land in distinct
    // dirs (the shared beforeEach puts proj/wt side by side under tmpdir).
    const projBase = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wti-pb-"));
    const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-wti-wb-"));
    const proj2 = path.join(projBase, "repo");
    const wt2 = path.join(wtBase, "wt");
    await fs.mkdir(proj2);
    await fs.mkdir(wt2);

    // A real, copyable source OUTSIDE the project, reachable via `..`. The old
    // code (path.join) would follow `..` and copy it to <wtBase>/pwned.txt.
    await fs.writeFile(path.join(projBase, "pwned.txt"), "OWNED");
    await fs.writeFile(path.join(proj2, ".env"), "OK=1");
    await fs.writeFile(path.join(proj2, ".worktreeinclude"), ".env\n../pwned.txt\n");

    const r = await applyWorktreeInclude(proj2, wt2);
    expect(r.copied).toEqual([".env"]);
    expect(r.missing).toEqual(["../pwned.txt"]);
    // The escaping write must NOT have happened.
    await expect(fs.access(path.join(wtBase, "pwned.txt"))).rejects.toThrow();

    await fs.rm(projBase, { recursive: true, force: true });
    await fs.rm(wtBase, { recursive: true, force: true });
  });
});
