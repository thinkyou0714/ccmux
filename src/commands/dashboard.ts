import chalk from "chalk";
import { loadConfig } from "../config/schema.js";
import {
  exportSessionForDashboard,
  type SessionExportRecord,
} from "../integrations/obsidian.js";
import fs from "fs/promises";
import { sessionsFile } from "../core/paths.js";

export interface DashboardOptions {
  /** When true, export ALL sessions in sessions.json. Default = false (last 7 days only). */
  all?: boolean;
  /** Override the Obsidian vault data path. */
  dataPath?: string;
  /** Skip Obsidian PUT and force local fallback. Useful for testing. */
  localOnly?: boolean;
}

interface RawSession {
  id?: string;
  name?: string;
  branch?: string;
  worktreePath?: string;
  status?: string;
  pid?: number;
  createdAt?: string;
  updatedAt?: string;
  costUSD?: number;
  project?: string;
  llmBackend?: string;
}

interface SessionsDB {
  version?: number;
  sessions?: RawSession[];
}

async function readSessions(): Promise<RawSession[]> {
  try {
    const raw = await fs.readFile(sessionsFile(), "utf-8");
    const db = JSON.parse(raw) as SessionsDB;
    return db.sessions ?? [];
  } catch {
    return [];
  }
}

function toExportRecord(s: RawSession): SessionExportRecord | null {
  if (!s.id || !s.name) return null;
  let durationSec: number | undefined;
  if (s.createdAt && s.updatedAt) {
    const t0 = Date.parse(s.createdAt);
    const t1 = Date.parse(s.updatedAt);
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      durationSec = Math.round((t1 - t0) / 1000);
    }
  }
  return {
    id: s.id,
    name: s.name,
    status: s.status ?? "unknown",
    costUSD: s.costUSD ?? 0,
    branch: s.branch,
    project: s.project,
    llmBackend: s.llmBackend,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    worktreePath: s.worktreePath,
    durationSec,
  };
}

function withinDays(iso: string | undefined, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= days * 86400 * 1000;
}

export async function dashboardCommand(
  subcommand: string | undefined,
  opts: DashboardOptions
): Promise<void> {
  const sub = subcommand ?? "refresh";
  if (sub !== "refresh") {
    console.error(chalk.red(`Unknown dashboard subcommand: ${sub}`));
    throw new Error();
  }

  const cfg = await loadConfig();
  const sessions = await readSessions();
  if (sessions.length === 0) {
    console.log(chalk.yellow("No sessions found in ~/.ccmux/sessions.json. Nothing to export."));
    return;
  }

  const candidates = opts.all
    ? sessions
    : sessions.filter((s) => withinDays(s.updatedAt ?? s.createdAt, 7));

  console.log(
    chalk.cyan(
      `Exporting ${candidates.length}/${sessions.length} sessions ` +
        `(${opts.all ? "all" : "last 7d"})...`
    )
  );

  let okCount = 0;
  let localCount = 0;
  for (const s of candidates) {
    const rec = toExportRecord(s);
    if (!rec) continue;
    const result = await exportSessionForDashboard(rec, {
      baseUrl: opts.localOnly ? "" : cfg.obsidian.baseUrl,
      apiKey: opts.localOnly ? "" : cfg.obsidian.apiKey,
      dataPath: opts.dataPath,
    });
    okCount++;
    if (result.sink === "local") localCount++;
  }

  console.log(
    chalk.green(`✔ exported ${okCount} sessions`) +
      (localCount > 0 ? chalk.yellow(` (${localCount} via local fallback — Obsidian REST unavailable)`) : "")
  );
  console.log(chalk.dim("\nOpen the dashboard:"));
  console.log(chalk.dim("  Obsidian → 05_OUTPUT/dashboards/ccmux-sessions.base"));
}
