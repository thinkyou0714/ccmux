import chalk from "chalk";
import { listSessions, pruneOrphanedSessions, type Session } from "../core/session.js";
import { loadConfig } from "../config/schema.js";
import { getTodayCost, formatCost } from "../core/cost.js";

export interface ListOptions {
  all?: boolean;
}

function statusColor(status: Session["status"]): string {
  switch (status) {
    case "busy": return chalk.yellow(status.toUpperCase().padEnd(8));
    case "idle": return chalk.green(status.toUpperCase().padEnd(8));
    case "done": return chalk.blue(status.toUpperCase().padEnd(8));
    case "error": return chalk.red(status.toUpperCase().padEnd(8));
    case "orphaned": return chalk.gray(status.toUpperCase().padEnd(8));
    default: return chalk.dim(status.toUpperCase().padEnd(8));
  }
}

function ago(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function getCost(session: Session, exchangeRate: number, currency: string): Promise<string> {
  if (session.costUSD === 0) return chalk.dim("N/A");
  const amount = currency === "JPY" ? session.costUSD * exchangeRate : session.costUSD;
  const sym = currency === "JPY" ? "¥" : "$";
  return `${sym}${amount.toFixed(currency === "JPY" ? 0 : 3)}`;
}

export async function listCommand(opts: ListOptions): Promise<void> {
  const pruned = await pruneOrphanedSessions();
  if (pruned > 0) {
    console.log(chalk.dim(`  (${pruned} orphaned session(s) detected and marked)`));
  }

  const cfg = await loadConfig();
  const sessions = await listSessions();
  const todayCost = await getTodayCost();

  if (sessions.length === 0) {
    const todayDisplay = todayCost
      ? formatCost(todayCost.costUSD, cfg.cost.currency, cfg.cost.exchangeRate)
      : "N/A";
    console.log(chalk.dim(`\n  No active sessions. Run \`ccmux new <name>\` to start.`));
    console.log(chalk.dim(`  today: ${todayDisplay}\n`));
    return;
  }

  const header = [
    chalk.bold("NAME".padEnd(20)),
    chalk.bold("STATUS  "),
    chalk.bold("BRANCH".padEnd(30)),
    chalk.bold("COST".padEnd(8)),
    chalk.bold("SINCE"),
  ].join("  ");

  console.log("\n" + header);
  console.log(chalk.dim("─".repeat(80)));

  let totalUSD = 0;
  for (const s of sessions) {
    const cost = await getCost(s, cfg.cost.exchangeRate, cfg.cost.currency);
    totalUSD += s.costUSD;

    const row = [
      s.name.padEnd(20),
      statusColor(s.status),
      s.branch.padEnd(30),
      cost.padEnd(8),
      ago(s.createdAt),
    ].join("  ");

    console.log(row);
  }

  const todayDisplay = todayCost
    ? formatCost(todayCost.costUSD, cfg.cost.currency, cfg.cost.exchangeRate)
    : chalk.dim("N/A");

  console.log(chalk.dim("─".repeat(80)));
  console.log(
    chalk.dim(`  ${sessions.length} session(s)  |  today: ${todayDisplay}`) +
    (todayCost ? chalk.dim(`  (${todayCost.models.join(", ")})`) : "") +
    "\n"
  );
}
