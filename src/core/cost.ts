import { execa } from "execa";
import { scrubEnv } from "./env-scrub.js";

interface DailyEntry {
  date: string;
  totalCost: number;
  totalTokens: number;
  modelsUsed: string[];
  modelBreakdowns: Array<{ modelName: string; cost: number }>;
}

interface CcusageJson {
  daily: DailyEntry[];
  totals: {
    totalCost: number;
    totalTokens: number;
  };
}

export interface DailyCostSummary {
  date: string;
  costUSD: number;
  tokens: number;
  models: string[];
}

let _cache: { data: CcusageJson; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function resolveWindowsUsername(): string | undefined {
  // H-05: derive Windows username at runtime instead of hardcoding "Rikuto".
  // USERPROFILE (set by Windows) is the most reliable source even from WSL2
  // when it's been exported across the boundary.
  const fromProfile = process.env.USERPROFILE?.split(/[\\/]/).filter(Boolean).pop();
  return (
    fromProfile ??
    process.env.WINDOWS_USERNAME ??
    process.env.USERNAME ??
    process.env.USER
  );
}

function resolveClaudeConfigDir(): string | undefined {
  // WSL2: Claude Code data lives under the Windows user profile, not the WSL home.
  // Explicit override always wins.
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;

  // Only attempt the WSL2 path if HOME looks POSIX (no Windows drive separator).
  if (!process.env.HOME || process.env.HOME.includes(":\\")) return undefined;

  const winUser = resolveWindowsUsername();
  if (!winUser) return undefined;
  return `/mnt/c/Users/${winUser}/.claude`;
}

async function fetchCcusage(): Promise<CcusageJson | null> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }
  try {
    // C-03 / H-02: scrubbed allowlist instead of inheriting process.env.
    const extra: Record<string, string> = {};
    const configDir = resolveClaudeConfigDir();
    if (configDir) extra["CLAUDE_CONFIG_DIR"] = configDir;
    const env = scrubEnv(extra);
    const { stdout } = await execa("npx", ["ccusage", "--json"], {
      stdio: "pipe",
      env,
      extendEnv: false,
    });
    const data = JSON.parse(stdout) as CcusageJson;
    _cache = { data, fetchedAt: Date.now() };
    return data;
  } catch {
    return null;
  }
}

export async function getTodayCost(): Promise<DailyCostSummary | null> {
  const data = await fetchCcusage();
  if (!data) return null;
  const today = new Date().toISOString().slice(0, 10);
  const entry = data.daily.find((d) => d.date === today);
  if (!entry) return null;
  return {
    date: entry.date,
    costUSD: entry.totalCost,
    tokens: entry.totalTokens,
    models: entry.modelsUsed,
  };
}

export async function getRecentCost(days = 7): Promise<DailyCostSummary[]> {
  const data = await fetchCcusage();
  if (!data) return [];
  return data.daily
    .slice(-days)
    .map((d) => ({
      date: d.date,
      costUSD: d.totalCost,
      tokens: d.totalTokens,
      models: d.modelsUsed,
    }));
}

export async function getTotalCost(): Promise<number | null> {
  const data = await fetchCcusage();
  return data?.totals.totalCost ?? null;
}

export function formatCost(usd: number, currency: "JPY" | "USD", rate: number): string {
  if (currency === "JPY") {
    return `¥${Math.round(usd * rate).toLocaleString()}`;
  }
  return `$${usd.toFixed(3)}`;
}
