import chalk from "chalk";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { loadConfig } from "../config/schema.js";
import { checkHealth } from "../integrations/autoclaw.js";

const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
  required?: boolean;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const ver = process.versions.node;
  const major = parseInt(ver.split(".")[0], 10);
  return {
    label: `Node.js >= 22 (found ${ver})`,
    ok: major >= 22,
  };
}

async function checkClaudeCli(): Promise<CheckResult> {
  try {
    const { stdout } = await execa("claude", ["--version"], { stdio: "pipe" });
    return { label: `claude CLI (${stdout.trim()})`, ok: true, required: true };
  } catch {
    return { label: "claude CLI", ok: false, detail: "not found in PATH", required: true };
  }
}

async function checkZellij(): Promise<CheckResult> {
  try {
    await execa("zellij", ["--version"], { stdio: "pipe" });
    const inSession = !!process.env.ZELLIJ_SESSION_NAME;
    return {
      label: `Zellij installed${inSession ? " + ZELLIJ_SESSION_NAME set" : " (not in session)"}`,
      ok: true,
      detail: inSession ? undefined : "not running inside a Zellij session",
    };
  } catch {
    return { label: "Zellij", ok: false, detail: "not installed" };
  }
}

async function checkTmux(): Promise<CheckResult> {
  try {
    await execa("tmux", ["-V"], { stdio: "pipe" });
    const inSession = !!process.env.TMUX;
    return {
      label: `tmux installed${inSession ? " + TMUX set" : " (not in session)"}`,
      ok: true,
      detail: inSession ? undefined : "not running inside a tmux session",
    };
  } catch {
    return { label: "tmux", ok: false, detail: "not installed" };
  }
}

async function checkCcusage(): Promise<CheckResult> {
  try {
    await execa("npx", ["ccusage", "--version"], { stdio: "pipe" });
    return { label: "ccusage", ok: true };
  } catch {
    return { label: "ccusage", ok: false, detail: "run: npm install -g ccusage" };
  }
}

async function checkConfig(): Promise<CheckResult> {
  const configFile = path.join(CCMUX_DIR, "config.json");
  try {
    const raw = await fs.readFile(configFile, "utf-8");
    JSON.parse(raw);
    return { label: `~/.ccmux/config.json exists and is valid`, ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: "~/.ccmux/config.json", ok: false, detail: msg };
  }
}

async function checkObsidian(): Promise<CheckResult | null> {
  const cfg = await loadConfig();
  if (!cfg.obsidian.enabled || !cfg.obsidian.apiKey) return null;

  try {
    const url = new URL("/vault/", cfg.obsidian.baseUrl);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cfg.obsidian.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      label: `Obsidian API (${cfg.obsidian.baseUrl})`,
      ok,
      detail: ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: `Obsidian API (${cfg.obsidian.baseUrl})`, ok: false, detail: msg };
  }
}

async function checkAutoclaw(): Promise<CheckResult> {
  const health = await checkHealth();
  return {
    label: `autoclaw (${health.url})`,
    ok: health.available,
    detail: health.available
      ? health.latencyMs !== undefined ? `${health.latencyMs}ms` : undefined
      : health.error,
  };
}

export async function doctorCommand(): Promise<void> {
  const [node, claude, zellij, tmux, ccusage, config] = await Promise.all([
    checkNodeVersion(),
    checkClaudeCli(),
    checkZellij(),
    checkTmux(),
    checkCcusage(),
    checkConfig(),
  ]);

  const obsidian = await checkObsidian();
  const autoclaw = await checkAutoclaw();

  const results: CheckResult[] = [node, claude, zellij, tmux, ccusage, config, autoclaw];
  if (obsidian) results.push(obsidian);

  console.log("\nccmux doctor\n");

  let criticalFail = false;

  for (const r of results) {
    const icon = r.ok ? chalk.green("✔") : chalk.red("✘");
    const label = r.ok ? r.label : chalk.red(r.label);
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : "";
    console.log(`  ${icon}  ${label}${detail}`);
    if (!r.ok && r.required) criticalFail = true;
  }

  console.log();

  if (criticalFail) {
    console.error(chalk.red("Required dependencies are missing. Please fix the issues above."));
    process.exit(1);
  }
}
