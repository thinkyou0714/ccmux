import chalk from "chalk";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { loadConfig } from "../config/schema.js";
import { checkHealth } from "../integrations/autoclaw.js";

function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}

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
  const configFile = path.join(ccmuxDir(), "config.json");
  try {
    await fs.access(configFile);
  } catch {
    return { label: "~/.ccmux/config.json", ok: false, detail: "not found — run: ccmux init" };
  }
  // Validate the way the rest of ccmux does (loadConfig = JSON parse + Zod), so
  // doctor reports a config that is valid JSON but fails schema validation
  // instead of mislabeling it "valid".
  try {
    await loadConfig();
    return { label: `~/.ccmux/config.json exists and is valid`, ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: "~/.ccmux/config.json", ok: false, detail: msg };
  }
}

async function checkObsidian(): Promise<CheckResult | null> {
  // Invalid config is reported by checkConfig(); skip here rather than crash.
  const cfg = await loadConfig().catch(() => null);
  if (!cfg || !cfg.obsidian.enabled || !cfg.obsidian.apiKey) return null;

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
  // checkHealth() loads config; an invalid config is reported by checkConfig(),
  // so degrade gracefully here rather than crashing the whole doctor run.
  let health: Awaited<ReturnType<typeof checkHealth>>;
  try {
    health = await checkHealth();
  } catch {
    return { label: "autoclaw", ok: false, detail: "skipped — config invalid (see config.json check)" };
  }
  return {
    label: `autoclaw (${health.url})`,
    ok: health.available,
    detail: health.available
      ? health.latencyMs !== undefined ? `${health.latencyMs}ms` : undefined
      : health.error,
  };
}

async function checkBubblewrap(): Promise<CheckResult | null> {
  // Only show bubblewrap check on Linux
  if (process.platform !== "linux") return null;

  try {
    const { stdout } = await execa("bwrap", ["--version"], { stdio: "pipe" });
    return { label: `bubblewrap sandbox (${stdout.trim()})`, ok: true };
  } catch {
    return {
      label: "bubblewrap sandbox",
      ok: false,
      detail: "optional but recommended for --sandbox mode — install: apt install bubblewrap",
    };
  }
}

async function checkAutoMemoryCost(): Promise<CheckResult> {
  const disabled = process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] === "1";
  return {
    label: `Auto-memory (background Opus extraction)`,
    ok: true,
    detail: disabled
      ? "disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1) — token cost is normal"
      : "enabled — doubles effective token consumption per turn; set CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to disable",
  };
}

async function checkOllama(): Promise<CheckResult | null> {
  // Invalid config is reported by checkConfig(); skip here rather than crash.
  const cfg = await loadConfig().catch(() => null);
  if (!cfg) return null;
  // Only check Ollama if autoclaw URL points to localhost:11434 (Ollama default)
  const isOllamaUrl =
    cfg.autoclaw.url.includes("localhost:11434") ||
    cfg.autoclaw.url.includes("127.0.0.1:11434");

  try {
    await execa("ollama", ["--version"], { stdio: "pipe" });
    const installed = true;

    if (isOllamaUrl) {
      // Also check if the configured model is pulled
      const model = cfg.autoclaw.model;
      if (model) {
        try {
          const { stdout } = await execa("ollama", ["list"], { stdio: "pipe" });
          const pulled = stdout.includes(model);
          return {
            label: `Ollama (model: ${model})`,
            ok: pulled,
            detail: pulled ? undefined : `model not pulled — run: ollama pull ${model}`,
          };
        } catch {
          return { label: "Ollama", ok: installed, detail: "installed but could not list models" };
        }
      }
      return { label: "Ollama", ok: true, detail: "installed (no model configured)" };
    }
    return null; // Ollama installed but autoclaw URL is not Ollama — don't show
  } catch {
    if (isOllamaUrl) {
      return {
        label: "Ollama",
        ok: false,
        detail: "not installed — run: curl -fsSL https://ollama.com/install.sh | sh",
      };
    }
    return null; // Not installed and not configured to use Ollama — skip
  }
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

  const [obsidian, autoclaw, ollama, bwrap, autoMem] = await Promise.all([
    checkObsidian(),
    checkAutoclaw(),
    checkOllama(),
    checkBubblewrap(),
    checkAutoMemoryCost(),
  ]);

  const results: CheckResult[] = [node, claude, zellij, tmux, ccusage, config, autoclaw];
  if (ollama) results.push(ollama);
  if (bwrap) results.push(bwrap);
  results.push(autoMem);
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
