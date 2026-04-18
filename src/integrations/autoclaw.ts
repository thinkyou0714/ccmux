import http from "http";
import { loadConfig } from "../config/schema.js";

export interface AutoclawHealth {
  available: boolean;
  url: string;
  latencyMs?: number;
  error?: string;
}

/** Check if the autoclaw proxy is reachable. */
export async function checkHealth(): Promise<AutoclawHealth> {
  const cfg = await loadConfig();
  const url = cfg.autoclaw.url;

  // Build a health-check URL: replace /task path with /health
  let healthUrl: string;
  try {
    const u = new URL(url);
    u.pathname = "/health";
    healthUrl = u.toString();
  } catch {
    return { available: false, url, error: "Invalid autoclaw URL in config" };
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(healthUrl, { timeout: 3000 }, (res) => {
      res.resume(); // consume response body
      const latencyMs = Date.now() - start;
      resolve({ available: res.statusCode === 200, url, latencyMs });
    });
    req.on("error", (err) => resolve({ available: false, url, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ available: false, url, error: "Connection timed out" });
    });
  });
}

/**
 * Return the shell command prefix for a given LLM backend.
 * Centralises the `ANTHROPIC_BASE_URL=... claude` pattern used across commands.
 */
export async function resolveClaudeCmd(backend: "claude" | "autoclaw"): Promise<string> {
  if (backend !== "autoclaw") return "claude";

  const cfg = await loadConfig();
  return `ANTHROPIC_BASE_URL="${cfg.autoclaw.url}" claude`;
}

/**
 * Send a task directly to autoclaw (fire-and-forget HTTP POST).
 * Returns the task ID assigned by autoclaw, or throws on failure.
 */
export async function routeTask(prompt: string): Promise<{ taskId: string }> {
  const cfg = await loadConfig();
  const url = new URL(cfg.autoclaw.url);

  const body = JSON.stringify({ prompt });
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data) as { task_id?: string; id?: string };
            resolve({ taskId: parsed.task_id ?? parsed.id ?? "unknown" });
          } catch {
            resolve({ taskId: "unknown" });
          }
        } else {
          reject(new Error(`autoclaw returned HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("autoclaw request timed out")); });
    req.write(body);
    req.end();
  });
}
