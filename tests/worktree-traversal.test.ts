import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { applyWorktreeInclude } from "../src/core/worktree.js";

let tmp: string;
let project: string;
let wt: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-trav-"));
  project = path.join(tmp, "project");
  wt = path.join(tmp, "wt");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(wt, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("applyWorktreeInclude (I-032 — path traversal guard)", () => {
  it("refuses a `..` entry that escapes the project dir and does not copy it", async () => {
    // A secret living OUTSIDE the project.
    await fs.writeFile(path.join(tmp, "secret.txt"), "TOPSECRET");
    await fs.writeFile(
      path.join(project, ".worktreeinclude"),
      "../secret.txt\nok.txt\n",
    );
    await fs.writeFile(path.join(project, "ok.txt"), "fine");

    const res = await applyWorktreeInclude(project, wt);

    expect(res.missing).toContain("../secret.txt");
    expect(res.copied).toContain("ok.txt");
    // The escaping path must NOT have been written anywhere under the worktree.
    await expect(fs.readFile(path.join(wt, "secret.txt"), "utf-8")).rejects.toThrow();
  });

  it("copies normal nested entries", async () => {
    await fs.mkdir(path.join(project, "cfg"), { recursive: true });
    await fs.writeFile(path.join(project, "cfg", "a.json"), "{}");
    await fs.writeFile(path.join(project, ".worktreeinclude"), "cfg/a.json\n");

    const res = await applyWorktreeInclude(project, wt);
    expect(res.copied).toContain("cfg/a.json");
    expect(await fs.readFile(path.join(wt, "cfg", "a.json"), "utf-8")).toBe("{}");
  });
});
