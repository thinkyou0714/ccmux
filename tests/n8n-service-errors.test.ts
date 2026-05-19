import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execa } from "execa";
import { saveConfig, type CcmuxConfig } from "../src/config/schema.js";
import { createSession } from "../src/core/session.js";
import { _closeDbForTests } from "../src/core/queue.js";
import { startServer } from "../src/integrations/n8n.js";

let tmp: string;
const origEnv = { ...process.env };
const origExit = process.exit;
let exitCalls: unknown[];

function config(overrides: Partial<CcmuxConfig> = {}): CcmuxConfig {
  return {
    version: 1,
    worktreeBase: path.join(tmp, "worktrees"),
    zellijSession: "lab",
    defaultProject: "app",
    projects: {},
    n8n: { enabled: true, webhookUrl: "", servePort: 0 },
    obsidian: { enabled: false, baseUrl: "", apiKey: "", handoffPath: "handoffs" },
    autoclaw: { url: "http://127.0.0.1:1/task" },
    cost: { enabled: false, currency: "USD", exchangeRate: 1 },
    logs: { maxAgeDays: 30, maxSizeMB: 100 },
    ...overrides,
  };
}

async function post(port: number, url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test User"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# test\n");
  await execa("git", ["add", "README.md"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-n8n-errors-"));
  process.env = { ...origEnv, CCMUX_DIR: tmp, HOME: tmp, CCMUX_QUEUE_DISABLED: "1" };
  exitCalls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    exitCalls.push(code);
    throw new Error(`process.exit(${code})`);
  };
});

afterEach(async () => {
  process.exit = origExit;
  _closeDbForTests();
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("n8n service error handling", () => {
  it("keeps serving after /session/new receives an unknown project", async () => {
    await saveConfig(config());
    const server = await startServer();
    try {
      const res = await post(server.port, "/session/new", { name: "bad", project: "missing" });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("Unknown project");
      expect(exitCalls).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it("keeps serving after /session/close hits uncommitted changes", async () => {
    const repo = path.join(tmp, "repo");
    const wtBase = path.join(tmp, "worktrees");
    const wt = path.join(wtBase, "dirty");
    await initGitRepo(repo);
    await fs.mkdir(wtBase, { recursive: true });
    await execa("git", ["-C", repo, "worktree", "add", "-b", "ccmux/dirty", wt]);
    await fs.writeFile(path.join(wt, "dirty.txt"), "dirty\n");
    await saveConfig(config({ worktreeBase: wtBase, projects: { app: { path: repo, defaultLlm: "claude" } } }));
    await createSession({
      name: "dirty",
      branch: "ccmux/dirty",
      worktreePath: wt,
      projectPath: repo,
      zellijTab: "ccmux:dirty",
      project: "app",
      llmBackend: "claude",
    });

    const server = await startServer();
    try {
      const res = await post(server.port, "/session/close", { name: "dirty" });
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toContain("uncommitted changes");
      expect(exitCalls).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("keeps serving after /webhook/github auto startup fails", async () => {
    await saveConfig(config({ defaultProject: "missing" }));
    const server = await startServer();
    try {
      const res = await post(
        server.port,
        "/webhook/github",
        { action: "opened", issue: { number: 123, title: "boom", body: "body" } },
        { "x-github-event": "issues" },
      );
      expect(res.status).toBe(500);
      expect(String(res.body.error)).toContain("defaultProject \"missing\" not found");
      expect(exitCalls).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
