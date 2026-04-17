import fs from "fs/promises";
import path from "path";

const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;
const CONFIG_FILE = path.join(CCMUX_DIR, "config.json");

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
  };
  obsidian: {
    enabled: boolean;
    handoffPath: string;
  };
  autoclaw: {
    url: string;
  };
  cost: {
    enabled: boolean;
    currency: "JPY" | "USD";
    exchangeRate: number;
  };
}

const DEFAULTS: CcmuxConfig = {
  version: 1,
  worktreeBase: `${process.env.HOME}/worktrees`,
  zellijSession: "lab",
  defaultProject: "think-you-lab",
  projects: {},
  n8n: { enabled: false, webhookUrl: "http://127.0.0.1:5679/webhook/ccmux", servePort: 9090 },
  obsidian: { enabled: false, handoffPath: "05_PROJECTS/ccmux-sessions" },
  autoclaw: { url: "http://autoclaw:3101/task" },
  cost: { enabled: true, currency: "JPY", exchangeRate: 155 },
};

let _config: CcmuxConfig | null = null;

export async function loadConfig(): Promise<CcmuxConfig> {
  if (_config) return _config;
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    _config = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CcmuxConfig>) };
  } catch {
    _config = { ...DEFAULTS };
  }
  return _config;
}

export async function saveConfig(cfg: CcmuxConfig): Promise<void> {
  await fs.mkdir(CCMUX_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  _config = cfg;
}

export async function initConfig(): Promise<void> {
  await fs.mkdir(CCMUX_DIR, { recursive: true });
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await saveConfig(DEFAULTS);
    console.log(`Created config at ${CONFIG_FILE}`);
  }
}
