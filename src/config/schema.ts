import fs from "fs/promises";
import path from "path";

// Phase: 90-pt roadmap — lazy resolution so tests can swap CCMUX_DIR / HOME
// after module load. Capturing these at module scope was forcing every test
// that touches config to monkey-patch fs.
function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.ccmux`;
}
function configFile(): string {
  return path.join(ccmuxDir(), "config.json");
}

export interface ProjectConfig {
  path: string;
  claudeMd?: string;
  settings?: string;
  defaultLlm: "claude" | "autoclaw";
}

export interface CcmuxConfig {
  version: number;
  worktreeBase: string;
  zellijSession: string;
  defaultProject: string;
  projects: Record<string, ProjectConfig>;
  n8n: {
    enabled: boolean;
    webhookUrl: string;
    servePort: number;
    authToken?: string;
    /**
     * HMAC-SHA256 shared secret for GitHub-style webhook signing (BL-1).
     * When set, /webhook/github requires a valid `X-Hub-Signature-256: sha256=<hex>`
     * computed over the raw request body using this secret. Requests without a
     * matching signature are rejected with 401.
     */
    webhookSecret?: string;
    tls?: { certFile: string; keyFile: string };
  };
  obsidian: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    handoffPath: string;
    handoffTemplatePath?: string;
    /** Opt-in: skip TLS verification for self-signed certs (default false). See README. */
    allowInsecureTLS?: boolean;
  };
  autoclaw: {
    url: string;
    /** Model name to pass via --model flag (e.g. "qwen3-coder" for Ollama). Omit to use server default. */
    model?: string;
    /** Auth token for the local proxy. Use "ollama" when pointing directly at Ollama. */
    authToken?: string;
  };
  cost: {
    enabled: boolean;
    currency: "JPY" | "USD";
    exchangeRate: number;
    budgetUSD?: number;
  };
  logs: {
    maxAgeDays: number;
    maxSizeMB: number;
  };
}

const DEFAULTS: CcmuxConfig = {
  version: 1,
  worktreeBase: `${process.env.HOME}/worktrees`,
  zellijSession: "lab",
  defaultProject: "think-you-lab",
  projects: {},
  n8n: { enabled: false, webhookUrl: "http://127.0.0.1:5679/webhook/ccmux", servePort: 9090 },
  obsidian: {
    enabled: true,
    baseUrl: "http://127.0.0.1:27123",
    apiKey: "",
    handoffPath: "05_PROJECTS/ccmux-sessions",
    allowInsecureTLS: false,
  },
  autoclaw: { url: "http://autoclaw:3101/task", model: undefined, authToken: undefined },
  cost: { enabled: true, currency: "JPY", exchangeRate: 155 },
  logs: { maxAgeDays: 30, maxSizeMB: 100 },
};

let _config: CcmuxConfig | null = null;

export async function loadConfig(): Promise<CcmuxConfig> {
  if (_config) return _config;

  let raw: string;
  try {
    raw = await fs.readFile(configFile(), "utf-8");
  } catch {
    // No config yet (first run) — use built-in defaults silently.
    _config = { ...DEFAULTS };
    return _config;
  }

  let parsed: Partial<CcmuxConfig>;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("config root is not a JSON object");
    }
    parsed = obj as Partial<CcmuxConfig>;
  } catch (err: unknown) {
    // A malformed config used to be swallowed silently, so a single typo meant
    // the CLI quietly ran with defaults (wrong project, wrong webhook port…)
    // with no hint why. Surface it, then fall back to defaults so the CLI runs.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `ccmux: ${configFile()} is malformed (${msg}); using built-in defaults.\n`,
    );
    _config = { ...DEFAULTS };
    return _config;
  }

  // Per-section merge so a partial user config (e.g. {"n8n":{"enabled":true}})
  // does not drop the other defaults of that section (webhookUrl/servePort/...).
  _config = {
    ...DEFAULTS,
    ...parsed,
    // F-08: `...parsed` copies an explicit null/wrong-typed scalar over the
    // default. A `"worktreeBase": null` then reaches path.join(null, name) and
    // throws a TypeError deep in createWorktree rather than being tolerated.
    // Re-coalesce the scalar top-level fields by type so only a value of the
    // right type can override the default.
    version: typeof parsed.version === "number" ? parsed.version : DEFAULTS.version,
    worktreeBase: typeof parsed.worktreeBase === "string" ? parsed.worktreeBase : DEFAULTS.worktreeBase,
    zellijSession: typeof parsed.zellijSession === "string" ? parsed.zellijSession : DEFAULTS.zellijSession,
    defaultProject: typeof parsed.defaultProject === "string" ? parsed.defaultProject : DEFAULTS.defaultProject,
    n8n: { ...DEFAULTS.n8n, ...parsed.n8n },
    obsidian: { ...DEFAULTS.obsidian, ...parsed.obsidian },
    autoclaw: { ...DEFAULTS.autoclaw, ...parsed.autoclaw },
    cost: { ...DEFAULTS.cost, ...parsed.cost },
    logs: { ...DEFAULTS.logs, ...parsed.logs },
    projects: { ...DEFAULTS.projects, ...parsed.projects },
  };
  return _config;
}

/**
 * REL-08: drop the process-wide cache so the next loadConfig() re-reads from
 * disk. loadConfig memoizes for the life of the process, so a long-lived daemon
 * (`ccmux serve`) otherwise never sees an edited ~/.ccmux/config.json (rotated
 * webhookSecret, toggled integration). The serve SIGHUP handler calls this.
 */
export function invalidateConfigCache(): void {
  _config = null;
}

export async function saveConfig(cfg: CcmuxConfig): Promise<void> {
  await fs.mkdir(ccmuxDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // DX-02: the `mode` above only applies when writeFile CREATES the file — an
  // existing config keeps its old (possibly group/world-readable) permissions.
  // Secrets live here (n8n.authToken/webhookSecret, obsidian.apiKey,
  // autoclaw.authToken), so re-tighten to 0600 on every save. chmod is a
  // near-no-op on Windows; never let it block a save.
  await fs.chmod(configFile(), 0o600).catch(() => {});
  _config = cfg;
}

export async function initConfig(): Promise<void> {
  await fs.mkdir(ccmuxDir(), { recursive: true });
  try {
    await fs.access(configFile());
  } catch {
    await saveConfig(DEFAULTS);
    console.log(`Created config at ${configFile()}`);
  }
}
