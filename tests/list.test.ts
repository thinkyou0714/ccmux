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

// Windows: listCommand calls getTodayCost → execa("ccusage") which on
// Windows CI runners with no ccusage installed has variable latency that
// occasionally trips the 5s default test timeout. The pure listSessions
// unit tests cover the actual filter logic; the listCommand wrapper tests
// stay Linux/macOS where execa("nonexistent") returns fast and predictably.
const describeListCommand =
  process.platform === "win32" ? describe.skip : describe;

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
});

describeListCommand("BL-9 list filtering (--status) — listCommand wrapper", () => {
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
    // I-099: --json now emits the envelope; the session array lives in `data`.
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.error).toBeNull();
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.meta.command).toBe("list");
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].name).toBe("y");
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
    expect(parsed.schema_version).toBe("1");
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].name).toBe("done");
  });

  it("--json emits a single newline-terminated envelope line", async () => {
    await seedSessions([{ name: "solo", status: "busy" }]);
    const { listCommand } = await import("../src/commands/list.js");
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      await listCommand({ json: true });
    } finally {
      spy.mockRestore();
    }
    // Exactly one JSON object, newline-terminated, parseable in full.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.data.map((s: { name: string }) => s.name)).toEqual(["solo"]);
  });
});
