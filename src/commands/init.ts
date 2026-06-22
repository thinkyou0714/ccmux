import chalk from "chalk";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { initConfig, loadConfig, saveConfig } from "../config/schema.js";

export interface InitOptions {
  withLitellm?: boolean;
  start?: boolean;
  force?: boolean;
  /** Override the LiteLLM port. Default 4101 (avoids the Docker Desktop / autoclaw collision at 3101 documented in the LAB runbook). */
  litellmPort?: number;
}

const DEFAULT_LITELLM_PORT = 4101;
// Lazy resolution so tests can swap HOME / USERPROFILE between cases.
function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}
function venvDir(): string {
  return path.join(home(), ".claude", "litellm-venv");
}
function localLitellmConfig(): string {
  return path.join(home(), ".claude", "litellm-config.yaml");
}

const MINIMAL_LITELLM_CONFIG = `model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: ollama/qwen2.5-coder:7b
      api_base: http://localhost:11434
      timeout: 120

  - model_name: claude-haiku-4-5
    litellm_params:
      model: ollama/qwen2.5-coder:7b
      api_base: http://localhost:11434
      timeout: 120

litellm_settings:
  drop_params: True
  set_verbose: False
`;

interface BootstrapResult {
  ok: boolean;
  step: string;
  detail?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function venvLitellmExe(): string {
  const exe = process.platform === "win32" ? "litellm.exe" : "litellm";
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  return path.join(venvDir(), sub, exe);
}

/** Try to find a usable Python 3.11+ executable. Returns the resolved path or null. */
async function findPython(): Promise<string | null> {
  const candidates = process.platform === "win32"
    ? ["py", "python", "python3"]
    : ["python3.13", "python3.12", "python3.11", "python3", "python"];
  for (const c of candidates) {
    try {
      const args = c === "py" ? ["-3.13", "--version"] : ["--version"];
      const r = await execa(c, args, { stdio: "pipe", reject: false });
      if (r.exitCode === 0) {
        // For `py -3.13` we need to keep the version arg pattern for future invocations.
        return c === "py" ? "py -3.13" : c;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function bootstrapLitellm(opts: InitOptions): Promise<BootstrapResult[]> {
  const results: BootstrapResult[] = [];
  const port = opts.litellmPort ?? DEFAULT_LITELLM_PORT;

  // Step 1: detect existing venv.
  const venvExe = venvLitellmExe();
  if (await pathExists(venvExe) && !opts.force) {
    results.push({ ok: true, step: "venv detect", detail: `found ${venvExe}` });
  } else {
    // Step 1a: find Python
    const py = await findPython();
    if (!py) {
      results.push({
        ok: false,
        step: "python detect",
        detail: "No Python 3.11+ found. Install Python 3.13 then re-run with --with-litellm.",
      });
      return results;
    }
    results.push({ ok: true, step: "python detect", detail: py });

    // Step 1b: create venv
    try {
      const [pyExe, ...pyArgs] = py.split(" ");
      await execa(pyExe, [...pyArgs, "-m", "venv", venvDir()], { stdio: "pipe" });
      results.push({ ok: true, step: "venv create", detail: venvDir() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ok: false, step: "venv create", detail: msg });
      return results;
    }

    // Step 1c: pip install litellm
    const pipExe = process.platform === "win32"
      ? path.join(venvDir(), "Scripts", "pip.exe")
      : path.join(venvDir(), "bin", "pip");
    try {
      await execa(pipExe, ["install", "litellm[proxy]"], { stdio: "pipe", timeout: 300_000 });
      results.push({ ok: true, step: "pip install litellm[proxy]" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ok: false, step: "pip install litellm[proxy]", detail: msg });
      return results;
    }
  }

  // Step 2: generate local litellm-config.yaml if missing
  if (await pathExists(localLitellmConfig()) && !opts.force) {
    results.push({ ok: true, step: "litellm config", detail: `exists ${localLitellmConfig()}` });
  } else {
    await fs.mkdir(path.dirname(localLitellmConfig()), { recursive: true });
    await fs.writeFile(localLitellmConfig(), MINIMAL_LITELLM_CONFIG, "utf-8");
    results.push({ ok: true, step: "litellm config", detail: `wrote ${localLitellmConfig()}` });
  }

  // Step 3: update ccmux config autoclaw.url
  try {
    const cfg = await loadConfig();
    const targetUrl = `http://localhost:${port}`;
    if (cfg.autoclaw.url !== targetUrl) {
      cfg.autoclaw = {
        ...cfg.autoclaw,
        url: targetUrl,
        model: cfg.autoclaw.model ?? "claude-sonnet-4-6",
        authToken: cfg.autoclaw.authToken ?? "ollama",
      };
      await saveConfig(cfg);
      results.push({ ok: true, step: "ccmux config", detail: `autoclaw.url -> ${targetUrl}` });
    } else {
      results.push({ ok: true, step: "ccmux config", detail: `already ${targetUrl}` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ ok: false, step: "ccmux config", detail: msg });
  }

  return results;
}

export async function initCommand(opts: InitOptions = {}): Promise<void> {
  // Step 0: base config
  await initConfig();
  console.log(chalk.green("ccmux config initialized at ~/.ccmux/config.json"));

  if (!opts.withLitellm) {
    console.log(chalk.dim("Tip: re-run with --with-litellm to set up a local-LLM proxy in one step."));
    return;
  }

  console.log("");
  console.log(chalk.cyan("Bootstrapping LiteLLM proxy..."));
  const steps = await bootstrapLitellm(opts);
  for (const s of steps) {
    const mark = s.ok ? chalk.green("✔") : chalk.red("✘");
    console.log(`  ${mark} ${s.step}${s.detail ? chalk.dim(` — ${s.detail}`) : ""}`);
  }
  if (steps.some((s) => !s.ok)) {
    console.log(chalk.red("\nLiteLLM bootstrap incomplete. See messages above and re-run."));
    throw new Error();
  }

  console.log("");
  console.log(chalk.green("LiteLLM bootstrap complete."));
  console.log(chalk.dim("Start the proxy with:"));
  if (process.platform === "win32") {
    console.log(chalk.dim(`  pwsh -File ${path.join(home(), ".claude", "scripts", "start_litellm_proxy.ps1")} -Background -Port ${opts.litellmPort ?? DEFAULT_LITELLM_PORT} -Config ${localLitellmConfig()}`));
  } else {
    console.log(chalk.dim(`  ${venvLitellmExe()} --config ${localLitellmConfig()} --port ${opts.litellmPort ?? DEFAULT_LITELLM_PORT} &`));
  }
  console.log(chalk.dim("Verify with: ccmux doctor"));
}
