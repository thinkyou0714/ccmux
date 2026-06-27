import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("skips unsafe traversal and absolute include entries", async () => {
    await fs.writeFile(path.join(proj, "safe.txt"), "SAFE=1");
    await fs.writeFile(
      path.join(proj, ".worktreeinclude"),
      [
        "safe.txt",
        "../outside-secret.txt",
        "nested/../secret.txt",
        "/absolute-secret.txt",
        "C:/absolute-secret.txt",
      ].join("\n")
    );

    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    });

    let r: Awaited<ReturnType<typeof applyWorktreeInclude>>;
    try {
      r = await applyWorktreeInclude(proj, wt);
    } finally {
      spy.mockRestore();
    }

    expect(r.copied).toEqual(["safe.txt"]);
    expect(r.missing).toEqual([]);
    expect(await fs.readFile(path.join(wt, "safe.txt"), "utf-8")).toBe("SAFE=1");
    expect(warnings.join("")).toContain('skipped unsafe path "../outside-secret.txt"');
    expect(warnings.join("")).toContain('skipped unsafe path "nested/../secret.txt"');
    expect(warnings.join("")).toContain('skipped unsafe path "/absolute-secret.txt"');
    expect(warnings.join("")).toContain('skipped unsafe path "C:/absolute-secret.txt"');
  });
});
