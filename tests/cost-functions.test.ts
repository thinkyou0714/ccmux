import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock execa (the `npx ccusage --json` call) so the cost fetchers are testable
// without the real ccusage binary. Hoisted so the mock factory can reference it.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const origEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules(); // fresh module-level cost cache per test
  execaMock.mockReset();
});

afterEach(() => {
  process.env = { ...origEnv };
});

async function importCost() {
  return import("../src/core/cost.js");
}

function ccusage(daily: Array<{ date: string; totalCost: number; totalTokens?: number; modelsUsed?: string[] }>, totalCost = 0) {
  return {
    stdout: JSON.stringify({
      daily: daily.map((d) => ({ modelsUsed: [], modelBreakdowns: [], totalTokens: 0, ...d })),
      totals: { totalCost, totalTokens: 0 },
    }),
  };
}

describe("resolveClaudeConfigDir", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.WINDOWS_USERNAME;
  });

  it("honours an explicit CLAUDE_CONFIG_DIR override", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/.claude";
    const { resolveClaudeConfigDir } = await importCost();
    expect(resolveClaudeConfigDir()).toBe("/custom/.claude");
  });

  it("maps to the Windows profile under WSL (posix HOME + windows user)", async () => {
    process.env.HOME = "/home/dev";
    process.env.WINDOWS_USERNAME = "alice";
    const { resolveClaudeConfigDir } = await importCost();
    expect(resolveClaudeConfigDir()).toBe("/mnt/c/Users/alice/.claude");
  });

  it("returns undefined on native Windows (HOME contains a drive prefix)", async () => {
    process.env.HOME = "C:\\Users\\dev";
    process.env.WINDOWS_USERNAME = "dev";
    const { resolveClaudeConfigDir } = await importCost();
    expect(resolveClaudeConfigDir()).toBeUndefined();
  });

  it("returns undefined when HOME is unset", async () => {
    delete process.env.HOME;
    const { resolveClaudeConfigDir } = await importCost();
    expect(resolveClaudeConfigDir()).toBeUndefined();
  });
});

describe("getTodayCost", () => {
  it("returns today's bucket by local date", async () => {
    const cost = await importCost();
    const today = cost.localToday();
    execaMock.mockResolvedValue(ccusage([{ date: today, totalCost: 1.25, totalTokens: 42, modelsUsed: ["opus"] }]));
    const r = await cost.getTodayCost();
    expect(r).toEqual({ date: today, costUSD: 1.25, tokens: 42, models: ["opus"] });
  });

  it("returns null when today has no entry", async () => {
    const cost = await importCost();
    execaMock.mockResolvedValue(ccusage([{ date: "1999-01-01", totalCost: 9 }]));
    expect(await cost.getTodayCost()).toBeNull();
  });

  it("returns null when ccusage output is unparseable", async () => {
    const cost = await importCost();
    execaMock.mockResolvedValue({ stdout: "not json" });
    expect(await cost.getTodayCost()).toBeNull();
  });

  it("returns null when ccusage is unavailable (execa throws)", async () => {
    const cost = await importCost();
    execaMock.mockRejectedValue(new Error("command not found: ccusage"));
    expect(await cost.getTodayCost()).toBeNull();
  });

  it("caches within the TTL — ccusage is invoked once for repeated reads", async () => {
    const cost = await importCost();
    const today = cost.localToday();
    execaMock.mockResolvedValue(ccusage([{ date: today, totalCost: 2 }]));
    await cost.getTodayCost();
    await cost.getTotalCost();
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});

describe("getRecentCost / getTotalCost", () => {
  it("returns the last N daily entries", async () => {
    const cost = await importCost();
    const daily = Array.from({ length: 10 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, totalCost: i }));
    execaMock.mockResolvedValue(ccusage(daily));
    const recent = await cost.getRecentCost(3);
    expect(recent.map((d) => d.date)).toEqual(["2026-06-08", "2026-06-09", "2026-06-10"]);
  });

  it("returns the overall total, or null when ccusage is unavailable", async () => {
    const cost = await importCost();
    execaMock.mockResolvedValue(ccusage([], 12.5));
    expect(await cost.getTotalCost()).toBe(12.5);
  });
});
