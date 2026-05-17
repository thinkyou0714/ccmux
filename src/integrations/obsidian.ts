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
