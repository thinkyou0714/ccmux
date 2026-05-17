import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { dashboardCommand } from "../src/commands/dashboard.js";
import { exportSessionForDashboard } from "../src/integrations/obsidian.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-dash-"));
  process.env.CCMUX_DIR = tmp;
  process.env.HOME = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("exportSessionForDashboard (Block F1)", () => {
  it("writes a markdown file with frontmatter via local fallback when Obsidian is unreachable", async () => {
    const fallback = path.join(tmp, "export");
    const result = await exportSessionForDashboard(
      {
        id: "id-1",
        name: "demo-session",
        status: "closed",
        costUSD: 0.42,
        branch: "ccmux/demo",
        project: "test",
        llmBackend: "autoclaw",
        createdAt: "2026-05-17T00:00:00Z",
        updatedAt: "2026-05-17T01:00:00Z",
      },
      { baseUrl: "", apiKey: "", localFallbackDir: fallback }
    );

    expect(result.sink).toBe("local");
    const content = await fs.readFile(result.path, "utf-8");
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/status: "closed"/);
    expect(content).toMatch(/costUSD: 0\.42/);
    expect(content).toMatch(/llm: "autoclaw"/);
    expect(content).toMatch(/# demo-session/);
  });

  it("escapes problematic characters in frontmatter strings", async () => {
    const fallback = path.join(tmp, "export");
    const result = await exportSessionForDashboard(
      {
        id: "id-quoted",
        name: 'name with "quotes" and \\backslash',
        status: "closed",
      },
      { baseUrl: "", apiKey: "", localFallbackDir: fallback }
    );
    const content = await fs.readFile(result.path, "utf-8");
    expect(content).toContain('name: "name with \\"quotes\\" and \\\\backslash"');
  });

  it("sanitizes session id when used as filename", async () => {
    const fallback = path.join(tmp, "export");
    const result = await exportSessionForDashboard(
      { id: "weird/id with spaces", name: "n", status: "closed" },
      { baseUrl: "", apiKey: "", localFallbackDir: fallback }
    );
    expect(path.basename(result.path)).toBe("weird_id_with_spaces.md");
  });
});

describe("dashboardCommand (Block F3)", () => {
  it("exports filtered sessions from sessions.json to local fallback", async () => {
    const sessionsFile = path.join(tmp, "sessions.json");
    const now = new Date().toISOString();
    await fs.writeFile(
      sessionsFile,
      JSON.stringify({
        version: 1,
        sessions: [
          { id: "a", name: "a", status: "closed", costUSD: 0.1, createdAt: now, updatedAt: now },
          { id: "b", name: "b", status: "closed", costUSD: 0.2, createdAt: now, updatedAt: now },
        ],
      })
    );

    await dashboardCommand("refresh", { all: true, localOnly: true });

    const fallbackDir = path.join(tmp, ".ccmux", "dashboard-export");
    const files = await fs.readdir(fallbackDir);
    expect(files.sort()).toEqual(["a.md", "b.md"]);
  });

  it("filters to last 7 days by default", async () => {
    const sessionsFile = path.join(tmp, "sessions.json");
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    await fs.writeFile(
      sessionsFile,
      JSON.stringify({
        version: 1,
        sessions: [
          { id: "recent", name: "recent", status: "closed", updatedAt: recent },
          { id: "old", name: "old", status: "closed", updatedAt: old },
        ],
      })
    );

    await dashboardCommand("refresh", { localOnly: true });

    const fallbackDir = path.join(tmp, ".ccmux", "dashboard-export");
    const files = await fs.readdir(fallbackDir);
    expect(files).toContain("recent.md");
    expect(files).not.toContain("old.md");
  });

  it("no-op when sessions.json is missing", async () => {
    await expect(dashboardCommand("refresh", { all: true, localOnly: true })).resolves.toBeUndefined();
  });
});
