import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { listSessions } from "../src/core/session.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-list-"));
  process.env.CCMUX_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedSessions(records: { name: string; status: string }[]): Promise<void> {
  const sessions = records.map((r, i) => ({
    id: `id-${i}`,
    name: r.name,
    branch: `ccmux/${r.name}`,
    worktreePath: `/tmp/${r.name}`,
    projectPath: "/tmp",
    zellijTab: `ccmux:${r.name}`,
    status: r.status,
    pid: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    costUSD: 0,
    project: "test",
    llmBackend: "claude",
  }));
  await fs.writeFile(
    path.join(tmp, "sessions.json"),
    JSON.stringify({ version: 1, sessions })
  );
}

describe("BL-9 list filtering (--status)", () => {
  it("listSessions() omits closed by default", async () => {
    await seedSessions([
      { name: "a", status: "busy" },
      { name: "b", status: "closed" },
      { name: "c", status: "error" },
    ]);
    const result = await listSessions();
    expect(result.map((s) => s.name).sort()).toEqual(["a", "c"]);
  });

  it("listSessions({ includeClosed: true }) returns everything", async () => {
    await seedSessions([
      { name: "a", status: "busy" },
      { name: "b", status: "closed" },
    ]);
    const result = await listSessions({ includeClosed: true });
    expect(result.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("listCommand --status=error returns only error sessions", async () => {
    await seedSessions([
      { name: "x", status: "closed" },
      { name: "y", status: "error" },
      { name: "z", status: "orphaned" },
    ]);
    const { listCommand } = await import("../src/commands/list.js");
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      await listCommand({ status: "error", json: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("y");
  });

  it("listCommand --status=closed includes closed sessions (implicit --all)", async () => {
    await seedSessions([
      { name: "live", status: "busy" },
      { name: "done", status: "closed" },
    ]);
    const { listCommand } = await import("../src/commands/list.js");
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      await listCommand({ status: "closed", json: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("done");
  });
});
