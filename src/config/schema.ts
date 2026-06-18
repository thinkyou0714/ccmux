import fs from "fs/promises";
import path from "path";
import { z } from "zod";

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

// ---------------------------------------------------------------------------
// Zod schema (runtime validation + deep-merge of defaults)
// ---------------------------------------------------------------------------
//
// Every field carries its own `.default(...)`, and every section object carries
// a `.prefault({})` (input-side default: an absent section is parsed as `{}` so
// its inner field defaults still apply). This gives true *deep* merge for free:
// a partial user config such as `{ "n8n": { "enabled": true } }` parses to a
// fully-populated section (webhookUrl/servePort fall back to their defaults)
// without a hand-rolled merge helper — Zod is the single source of truth for
// both shape and defaults, so the schema and DEFAULTS can never drift apart.
//
// Unknown keys are stripped (Zod's default object behaviour) rather than
// rejected, which keeps older binaries forward-compatible with configs that
// gained new fields. Known keys *are* validated: wrong types, bad enum values,
// etc. surface as actionable errors instead of silently mis-behaving.

const ProjectConfigSchema = z.object({
  path: z.string(),
  claudeMd: z.string().optional(),
  settings: z.string().optional(),
  defaultLlm: z.enum(["claude", "autoclaw"]).default("claude"),
});

const ConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  worktreeBase: z.string().default(`${process.env.HOME}/worktrees`),
  zellijSession: z.string().default("lab"),
  defaultProject: z.string().default("think-you-lab"),
  projects: z.record(z.string(), ProjectConfigSchema).default({}),
  n8n: z
    .object({
      enabled: z.boolean().default(false),
      webhookUrl: z.string().default("http://127.0.0.1:5679/webhook/ccmux"),
      servePort: z.number().int().min(1).max(65535).default(9090),
      authToken: z.string().optional(),
      webhookSecret: z.string().optional(),
      tls: z.object({ certFile: z.string(), keyFile: z.string() }).optional(),
    })
    .prefault({}),
  obsidian: z
    .object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().default("http://127.0.0.1:27123"),
      apiKey: z.string().default(""),
      handoffPath: z.string().default("05_PROJECTS/ccmux-sessions"),
      handoffTemplatePath: z.string().optional(),
      allowInsecureTLS: z.boolean().default(false),
    })
    .prefault({}),
  autoclaw: z
    .object({
      url: z.string().default("http://autoclaw:3101/task"),
      model: z.string().optional(),
      authToken: z.string().optional(),
    })
    .prefault({}),
  cost: z
    .object({
      enabled: z.boolean().default(true),
      currency: z.enum(["JPY", "USD"]).default("JPY"),
      exchangeRate: z.number().positive().default(155),
      budgetUSD: z.number().positive().optional(),
    })
    .prefault({}),
  logs: z
    .object({
      maxAgeDays: z.number().int().nonnegative().default(30),
      maxSizeMB: z.number().int().nonnegative().default(100),
    })
    .prefault({}),
});

// Deriving DEFAULTS from the schema (rather than a separate literal) binds the
// two together: the `CcmuxConfig` annotation makes tsc fail the build if the
// schema's inferred type ever drifts from the public interface.
const DEFAULTS: CcmuxConfig = ConfigSchema.parse({});

let _config: CcmuxConfig | null = null;

export async function loadConfig(): Promise<CcmuxConfig> {
  if (_config) return _config;

  let raw: string;
  try {
    raw = await fs.readFile(configFile(), "utf-8");
  } catch {
    // No config file (fresh install) — defaults are the expected behaviour.
    _config = ConfigSchema.parse({});
    return _config;
  }

  // The file exists: a malformed config is a user error we must surface, not
  // silently swallow into defaults (which would mask the mistake and run with
  // the wrong settings).
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `ccmux: ${configFile()} is not valid JSON — ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `ccmux: invalid config at ${configFile()}\n${z.prettifyError(result.error)}`,
    );
  }

  _config = result.data;
  return _config;
}

export async function saveConfig(cfg: CcmuxConfig): Promise<void> {
  await fs.mkdir(ccmuxDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
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
