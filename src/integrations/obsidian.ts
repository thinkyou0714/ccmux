import https from "https";
import http from "http";

interface ObsidianConfig {
  baseUrl: string;
  apiKey: string;
  handoffPath: string;
}

interface HandoffData {
  sessionName: string;
  branch: string;
  diff: string;
  costUSD?: number;
  currency?: "JPY" | "USD";
  exchangeRate?: number;
}

function resolveObsidianConfig(cfg: ObsidianConfig): ObsidianConfig {
  return {
    baseUrl: process.env.OBSIDIAN_BASE_URL ?? cfg.baseUrl,
    apiKey: process.env.OBSIDIAN_API_KEY ?? cfg.apiKey,
    handoffPath: cfg.handoffPath,
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
        // Allow self-signed certs from Obsidian REST API
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

  const costLine =
    data.costUSD != null
      ? data.currency === "JPY"
        ? `- cost: ¥${Math.round(data.costUSD * (data.exchangeRate ?? 150))}`
        : `- cost: $${data.costUSD.toFixed(3)}`
      : "";

  const content = [
    `# ccmux handoff: ${data.sessionName}`,
    ``,
    `- date: ${new Date().toISOString()}`,
    `- branch: ${data.branch}`,
    costLine,
    ``,
    `## diff summary`,
    ``,
    `\`\`\``,
    data.diff || "(no changes)",
    `\`\`\``,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    await obsidianRequest(resolved, vaultPath, content);
    return true;
  } catch {
    return false;
  }
}
