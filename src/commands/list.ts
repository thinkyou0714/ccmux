import chalk from "chalk";
import { listSessions, pruneOrphanedSessions, type Session } from "../core/session.js";
import { loadConfig } from "../config/schema.js";
import { getTodayCost, formatCost } from "../core/cost.js";

export interface ListOptions {
  all?: boolean;
  json?: boolean;
  status?: string;
}

function statusColor(status: Session["status"]): string {
  const cell = status.toUpperCase().padEnd(8);
  switch (status) {
    case "created": return chalk.cyan(cell);
    case "starting": return chalk.cyan(cell);
    case "busy": return chalk.yellow(cell);
    case "idle": return chalk.green(cell);
    case "done": return chalk.blue(cell);
    case "error": return chalk.red(cell);
    case "orphaned": return chalk.gray(cell);
    default: return chalk.dim(cell);
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

// Returns a *plain* (uncolored) string so callers can pad it to a fixed width
// before applying color — padding a chalk string counts the invisible ANSI
// escape bytes and misaligns the column.
function getCost(session: Session, exchangeRate: number, currency: string): string {
  if (session.costUSD === 0) return "N/A";
  const amount = currency === "JPY" ? session.costUSD * exchangeRate : session.costUSD;
  const sym = currency === "JPY" ? "¥" : "$";
  return `${sym}${amount.toFixed(currency === "JPY" ? 0 : 3)}`;
}

export async function listCommand(opts: ListOptions): Promise<void> {
  const pruned = await pruneOrphanedSessions();

  const cfg = await loadConfig();
  // --status implies "look at every status (including closed)" so users can
  // filter to `closed` for handoff browsing or `error/orphaned` for recovery.
  const includeClosed = Boolean(opts.all || opts.status);
  let sessions = await listSessions({ includeClosed });
  if (opts.status) {
    sessions = sessions.filter((s) => s.status === opts.status);
  }
  const todayCost = await getTodayCost();

  if (opts.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }

  if (pruned > 0) {
    console.log(chalk.dim(`  (${pruned} orphaned session(s) detected and marked)`));
  }

  if (cfg.cost.budgetUSD != null && todayCost && todayCost.costUSD > cfg.cost.budgetUSD) {
    const sym = cfg.cost.currency === "JPY" ? "¥" : "$";
    const spent = cfg.cost.currency === "JPY"
      ? `${sym}${Math.round(todayCost.costUSD * cfg.cost.exchangeRate)}`
      : `${sym}${todayCost.costUSD.toFixed(3)}`;
    const budget = cfg.cost.currency === "JPY"
      ? `${sym}${Math.round(cfg.cost.budgetUSD * cfg.cost.exchangeRate)}`
      : `${sym}${cfg.cost.budgetUSD.toFixed(3)}`;
    console.log(chalk.yellow(`  ⚠  daily budget exceeded (${spent} / ${budget})`));
  }

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

  let _totalUSD = 0;
  for (const s of sessions) {
    const cost = getCost(s, cfg.cost.exchangeRate, cfg.cost.currency);
    _totalUSD += s.costUSD;

    // Pad to the column width first, then color, so ANSI bytes don't skew it.
    const costCell = cost === "N/A" ? chalk.dim(cost.padEnd(8)) : cost.padEnd(8);

    const row = [
      s.name.padEnd(20),
      statusColor(s.status),
      s.branch.padEnd(30),
      costCell,
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
