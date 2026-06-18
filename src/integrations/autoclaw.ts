import http from "http";
import https from "https";
import { loadConfig, CcmuxConfig } from "../config/schema.js";

/**
 * I-081: hard cap on the response body {@link routeTask} will buffer. autoclaw's
 * reply is a tiny JSON object; this only guards against a buggy/hostile upstream
 * streaming an unbounded body into memory. 1 MiB is generously above any
 * legitimate `{task_id}` payload.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
  // Pick the transport from the URL scheme — using http for an https:// URL
  // would connect in cleartext and leak the Bearer token.
  const lib = healthUrl.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(healthUrl, { timeout: 3000 }, (res) => {
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
  let cmd = `ANTHROPIC_BASE_URL="${cfg.autoclaw.url}" claude`;
  if (cfg.autoclaw.model) {
    cmd += ` --model ${cfg.autoclaw.model}`;
  }
  return cmd;
}

/**
 * I-089: cloud credentials that must NOT propagate into a local-LLM (autoclaw)
 * child running with `--dangerously-skip-permissions`. A prompt-injected agent
 * pointed at a local model has no business holding cloud API keys / tokens, and
 * leaking them widens the blast radius of any escape.
 *
 * Deliberately a deny-list (not a strict allow-list): the child still needs PATH,
 * HOME, locale, terminal, proxy, etc., and an over-eager allow-list would silently
 * break claude in hard-to-debug ways. We remove the known-sensitive cloud vars and
 * leave everything else intact.
 */
const CLOUD_CREDENTIAL_ENV = [
  // Anthropic / Claude cloud auth
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  // AWS (Bedrock and general)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  // Google Cloud / Vertex
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "GCP_PROJECT",
  // Azure
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  // Other LLM providers
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  // Source-control tokens
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
] as const;

/**
 * Build the environment object for spawning claude with a given backend.
 * Use this instead of constructing env manually to centralise auth token + URL handling.
 *
 * For Ollama: set autoclaw.url = "http://localhost:11434"
 *             and autoclaw.authToken = "ollama" in config.
 * For LiteLLM: set autoclaw.url = "http://localhost:3101" and leave authToken blank.
 */
export function buildClaudeEnv(
  backend: "claude" | "autoclaw",
  cfg: CcmuxConfig,
  sessionName?: string
): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (sessionName) env["CCMUX_SESSION"] = sessionName;

  if (backend === "autoclaw") {
    // I-089: strip cloud credentials before handing the env to the local-LLM
    // child. Done first so the autoclaw URL/token set below are not clobbered.
    for (const key of CLOUD_CREDENTIAL_ENV) {
      delete env[key];
    }

    env["ANTHROPIC_BASE_URL"] = cfg.autoclaw.url;
    // When pointing directly at Ollama, the SDK requires a non-empty auth token.
    // "ollama" is the conventional placeholder. This is the *local* proxy token
    // from config, not an inherited cloud credential.
    if (cfg.autoclaw.authToken) {
      env["ANTHROPIC_AUTH_TOKEN"] = cfg.autoclaw.authToken;
    }
  }

  return env;
}

/**
 * Return the model name to pass via --model if configured.
 * Returns undefined if no model override is set (uses server default).
 */
export async function resolveClaudeModel(backend: "claude" | "autoclaw"): Promise<string | undefined> {
  if (backend !== "autoclaw") return undefined;
  const cfg = await loadConfig();
  return cfg.autoclaw.model;
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
    // Set once we abort on overflow so the subsequent socket 'error' is ignored.
    let aborted = false;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(cfg.autoclaw.authToken ? { Authorization: `Bearer ${cfg.autoclaw.authToken}` } : {}),
      },
      timeout: 10000,
    };

    // Use https for https:// URLs (cleartext http would leak the auth token,
    // and the default port would be wrong).
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(options, (res) => {
      // I-081: bound the response we buffer. autoclaw should reply with a tiny
      // JSON `{task_id}`; an unbounded `data += chunk` lets a buggy/hostile
      // upstream stream us out of memory. Collect Buffers (not strings) so the
      // size check is exact and we decode once at the end — concatenating
      // per-chunk strings could split a multi-byte UTF-8 sequence.
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          aborted = true;
          req.destroy();
          reject(new Error(`autoclaw response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (aborted) return;
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const data = Buffer.concat(chunks).toString("utf-8");
          try {
            const parsed = JSON.parse(data) as { task_id?: string; id?: string };
            resolve({ taskId: parsed.task_id ?? parsed.id ?? "unknown" });
          } catch {
            resolve({ taskId: "unknown" });
          }
        } else {
          // Don't embed the upstream response body in the error — it can carry
          // internal details / secrets and propagates to logs/callers (H-12).
          reject(new Error(`autoclaw returned HTTP ${res.statusCode}`));
        }
      });
    });

    req.on("error", (err) => {
      // After we req.destroy() on overflow the socket emits an error; we've
      // already rejected with the meaningful message, so swallow this one.
      if (aborted) return;
      reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("autoclaw request timed out")); });
    req.write(body);
    req.end();
  });
}
