import https from "https";
import http from "http";
import fs from "fs/promises";

interface ObsidianConfig {
  baseUrl: string;
  apiKey: string;
  handoffPath: string;
  handoffTemplatePath?: string;
}

export interface HandoffData {
  sessionName: string;
  branch: string;
  diff: string;
  costUSD?: number;
  currency?: "JPY" | "USD";
  exchangeRate?: number;
  claudeMdContent?: string;
  todos?: string[];
  gitLog?: string;
}

function resolveObsidianConfig(cfg: ObsidianConfig): ObsidianConfig {
  return {
    baseUrl: process.env.OBSIDIAN_BASE_URL ?? cfg.baseUrl,
    apiKey: process.env.OBSIDIAN_API_KEY ?? cfg.apiKey,
    handoffPath: cfg.handoffPath,
    handoffTemplatePath: cfg.handoffTemplatePath,
  };
}

async function obsidianRequest(
  cfg: ObsidianConfig,
  vaultRelPath: string,
  content: string
): Promise<void> {
  const url = new URL(`/vault/${encodeURIComponent(vaultRelPath)}`, cfg.baseUrl);
  const body = Buffer.from(content, "utf-8");

  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "text/markdown",
          "Content-Length": body.length,
        },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Obsidian API returned ${res.statusCode}`));
        }
        res.resume();
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("Obsidian API timeout"));
    });
    req.write(body);
    req.end();
  });
}

function buildDefaultContent(data: HandoffData): string {
  const date = new Date().toISOString();
  const costLine =
    data.costUSD != null
      ? data.currency === "JPY"
        ? `- cost: ¥${Math.round(data.costUSD * (data.exchangeRate ?? 150))}`
        : `- cost: $${data.costUSD.toFixed(3)}`
      : "";

  const parts: string[] = [
    `# ccmux handoff: ${data.sessionName}`,
    ``,
    `- date: ${date}`,
    `- branch: ${data.branch}`,
  ];
  if (costLine) parts.push(costLine);
  parts.push(``, `## diff summary`, ``, `\`\`\``, data.diff || "(no changes)", `\`\`\``);

  if (data.gitLog) {
    parts.push(``, `## git log`, ``, `\`\`\``, data.gitLog, `\`\`\``);
  }

  if (data.todos && data.todos.length > 0) {
    parts.push(``, `## todos`, ``);
    for (const todo of data.todos) {
      parts.push(`- [ ] ${todo}`);
    }
  }

  if (data.claudeMdContent) {
    parts.push(``, `## CLAUDE.md`, ``, data.claudeMdContent);
  }

  parts.push(``);
  return parts.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

function applyTemplate(template: string, data: HandoffData): string {
  const date = new Date().toISOString().slice(0, 10);
  const costStr =
    data.costUSD != null
      ? data.currency === "JPY"
        ? `¥${Math.round(data.costUSD * (data.exchangeRate ?? 150))}`
        : `$${data.costUSD.toFixed(3)}`
      : "N/A";

  return template
    .replace(/\{\{sessionName\}\}/g, data.sessionName)
    .replace(/\{\{branch\}\}/g, data.branch)
    .replace(/\{\{diff\}\}/g, data.diff || "(no changes)")
    .replace(/\{\{claudeMd\}\}/g, data.claudeMdContent ?? "")
    .replace(/\{\{todos\}\}/g, data.todos ? data.todos.map((t) => `- [ ] ${t}`).join("\n") : "")
    .replace(/\{\{cost\}\}/g, costStr)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{gitLog\}\}/g, data.gitLog ?? "");
}

// ---------------------------------------------------------------------------
// Dashboard export (Phase: 90-point roadmap, observability ＋11 / 5→11).
//
// One markdown file per session under 05_OUTPUT/data/ccmux-sessions/<id>.md
// with frontmatter properties that the Obsidian Bases dashboard
// (05_OUTPUT/dashboards/ccmux-sessions.base) filters and aggregates on.
// ---------------------------------------------------------------------------

export interface SessionExportRecord {
  id: string;
  name: string;
  status: string;
  costUSD?: number;
  branch?: string;
  project?: string;
  llmBackend?: string;
  createdAt?: string;
  updatedAt?: string;
  worktreePath?: string;
  iterations?: number;
  durationSec?: number;
}

export interface DashboardExportConfig {
  baseUrl?: string;
  apiKey?: string;
  /** Vault path to the folder receiving per-session markdown files. */
  dataPath?: string;
  /** Local fallback dir when Obsidian PUT fails. Default ~/.ccmux/dashboard-export. */
  localFallbackDir?: string;
}

const DEFAULT_DATA_PATH = "05_OUTPUT/data/ccmux-sessions";

function frontmatterValue(v: unknown): string {
  if (v == null) return '""';
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  // YAML-safe string quoting: wrap in double quotes and escape backslash + dquote.
  const s = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${s}"`;
}

function buildSessionMarkdown(rec: SessionExportRecord): string {
  const lines = ["---"];
  lines.push(`ccmux_session: ${frontmatterValue(rec.id)}`);
  lines.push(`name: ${frontmatterValue(rec.name)}`);
  lines.push(`status: ${frontmatterValue(rec.status)}`);
  if (rec.costUSD != null) lines.push(`costUSD: ${rec.costUSD}`);
  if (rec.iterations != null) lines.push(`iterations: ${rec.iterations}`);
  if (rec.durationSec != null) lines.push(`durationSec: ${rec.durationSec}`);
  if (rec.branch) lines.push(`branch: ${frontmatterValue(rec.branch)}`);
  if (rec.project) lines.push(`project: ${frontmatterValue(rec.project)}`);
  if (rec.llmBackend) lines.push(`llm: ${frontmatterValue(rec.llmBackend)}`);
  if (rec.createdAt) lines.push(`createdAt: ${frontmatterValue(rec.createdAt)}`);
  if (rec.updatedAt) lines.push(`updatedAt: ${frontmatterValue(rec.updatedAt)}`);
  lines.push("tags:");
  lines.push("  - ccmux-session");
  lines.push(`  - status/${rec.status || "unknown"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${rec.name}`);
  lines.push("");
  lines.push(`Session id: \`${rec.id}\``);
  if (rec.worktreePath) lines.push(`Worktree: \`${rec.worktreePath}\``);
  lines.push("");
  lines.push("> Auto-generated by ccmux dashboard export. Filtered by `ccmux-sessions.base`.");
  lines.push("");
  return lines.join("\n");
}

async function writeLocalFallback(dir: string, sessionId: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const safeId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const target = `${dir}/${safeId}.md`;
  await fs.writeFile(target, content, "utf-8");
  return target;
}

export interface ExportResult {
  sink: "obsidian" | "local";
  path: string;
}

export async function exportSessionForDashboard(
  rec: SessionExportRecord,
  cfg: DashboardExportConfig
): Promise<ExportResult> {
  const content = buildSessionMarkdown(rec);
  const baseUrl = process.env.OBSIDIAN_BASE_URL ?? cfg.baseUrl ?? "";
  const apiKey = process.env.OBSIDIAN_API_KEY ?? cfg.apiKey ?? "";
  const dataPath = cfg.dataPath ?? DEFAULT_DATA_PATH;
  const safeId = rec.id.replace(/[^A-Za-z0-9_.-]/g, "_");
  const vaultPath = `${dataPath}/${safeId}.md`;

  if (baseUrl && apiKey) {
    try {
      await obsidianRequest(
        { baseUrl, apiKey, handoffPath: dataPath },
        vaultPath,
        content
      );
      return { sink: "obsidian", path: vaultPath };
    } catch {
      /* fall through to local */
    }
  }

  const fallbackDir =
    cfg.localFallbackDir ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.ccmux/dashboard-export`;
  const localPath = await writeLocalFallback(fallbackDir, rec.id, content);
  return { sink: "local", path: localPath };
}

export async function writeObsidianHandoff(
  data: HandoffData,
  cfg: ObsidianConfig
): Promise<boolean> {
  const resolved = resolveObsidianConfig(cfg);
  if (!resolved.apiKey || !resolved.baseUrl) return false;

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  const fileName = `${date}-${time}-${data.sessionName}.md`;
  const vaultPath = `${resolved.handoffPath}/${fileName}`;

  let content: string;
  if (resolved.handoffTemplatePath) {
    try {
      const template = await fs.readFile(resolved.handoffTemplatePath, "utf-8");
      content = applyTemplate(template, data);
    } catch {
      content = buildDefaultContent(data);
    }
  } else {
    content = buildDefaultContent(data);
  }

  try {
    await obsidianRequest(resolved, vaultPath, content);
    return true;
  } catch {
    return false;
  }
}
