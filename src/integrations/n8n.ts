import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs/promises";
import { loadConfig } from "../config/schema.js";
import { newCommand } from "../commands/new.js";
import { closeCommand } from "../commands/close.js";
import { listSessions } from "../core/session.js";
import { autoCommand } from "../commands/auto.js";
import { claimSession, releaseSession } from "../core/queue.js";

type JsonBody = Record<string, unknown>;

interface RawBody {
  raw: Buffer;
  json: JsonBody;
}

function readBody(req: http.IncomingMessage): Promise<RawBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      try {
        const json = raw.length === 0 ? {} : (JSON.parse(raw.toString("utf-8")) as JsonBody);
        resolve({ raw, json });
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function checkAuth(req: http.IncomingMessage, authToken: string): boolean {
  // H-03: authToken is required; callers must enforce its presence before
  // reaching here. The previous `if (!authToken) return true` bypassed auth
  // entirely when the config field was missing — startServer now refuses
  // to start in that case (unless CCMUX_N8N_ALLOW_NOAUTH=1).
  const header = req.headers["authorization"];
  if (!header) return false;
  const expected = `Bearer ${authToken}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * BL-1: Constant-time HMAC-SHA256 verification of GitHub-style webhook payloads.
 *
 * The signature header must be `sha256=<hex>` computed over the *raw* request
 * body (post-JSON-parse re-serialization will not match — body whitespace and
 * key order matter to GitHub's signing).
 *
 * Returns false for any missing/malformed input rather than throwing, to
 * preserve constant-time behaviour at the call site.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  if (typeof signatureHeader !== "string") return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch — guard first.
  if (sigBuf.length !== expBuf.length) return false;
  try {
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken: string | null,
  webhookSecret: string | undefined,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/health") {
    return send(res, 200, { ok: true });
  }

  // /webhook/github uses HMAC signature instead of Bearer auth.
  // All other endpoints require Bearer auth — unless explicit opt-out via
  // CCMUX_N8N_ALLOW_NOAUTH (signaled by authToken === null).
  const isWebhook = method === "POST" && url === "/webhook/github";
  if (!isWebhook && authToken !== null && !checkAuth(req, authToken)) {
    return send(res, 401, { error: "Unauthorized" });
  }

  try {
    if (method === "GET" && url === "/session/list") {
      const sessions = await listSessions();
      return send(res, 200, { sessions });
    }

    if (method === "POST" && url === "/session/new") {
      const { json: body } = await readBody(req);
      const name = body.name as string | undefined;
      const project = body.project as string | undefined;
      const llm = (body.llm as "claude" | "autoclaw" | undefined) ?? "claude";

      if (!name) return send(res, 400, { error: "name is required" });

      await newCommand(name, { project, llm });
      return send(res, 201, { ok: true, name });
    }

    if (method === "POST" && url === "/session/close") {
      const { json: body } = await readBody(req);
      const name = body.name as string | undefined;
      if (!name) return send(res, 400, { error: "name is required" });

      await closeCommand(name, {});
      return send(res, 200, { ok: true, name });
    }

    if (isWebhook) {
      const event = req.headers["x-github-event"];
      if (event !== "issues") {
        return send(res, 200, { ok: false, reason: "not an issues event" });
      }

      // Read raw body *before* parsing so HMAC verification matches sender bytes.
      const { raw, json: body } = await readBody(req);

      // BL-1: HMAC signature gate. When webhookSecret is configured, every
      // request must include a valid X-Hub-Signature-256 header. Missing
      // secret = unauthenticated webhook (warned at startup).
      if (webhookSecret) {
        const sig = req.headers["x-hub-signature-256"];
        const sigStr = Array.isArray(sig) ? sig[0] : sig;
        if (!verifyGitHubSignature(raw, sigStr, webhookSecret)) {
          return send(res, 401, { error: "Invalid signature" });
        }
      }

      const action = body.action as string | undefined;
      if (action !== "opened") {
        return send(res, 200, { ok: false, reason: "not an opened action" });
      }

      const issue = body.issue as { number: number; title: string; body?: string } | undefined;
      if (!issue) return send(res, 400, { error: "issue payload missing" });

      const sessionName = `issue-${issue.number}`;
      const prompt = `Issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ""}`;

      // BL-6: SQLite dedup queue. The webhook receiver is the only place a
      // race can happen (n8n retry + GitHub redelivery both hitting at once);
      // the queue gives us an atomic INSERT OR IGNORE so the second caller
      // returns 200 with `dedup: true` without ever spawning a worktree.
      const claim = claimSession(sessionName, "github");
      if (!claim.claimed) {
        return send(res, 200, {
          ok: true,
          dedup: true,
          sessionName,
          existing: claim.existing,
        });
      }

      try {
        await autoCommand(sessionName, { prompt });
      } catch (cmdErr: unknown) {
        // Auto failed before close — drop the queue row so a manual
        // re-trigger isn't permanently blocked by the dedup gate.
        releaseSession(sessionName);
        const message = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        return send(res, 500, { error: message, sessionName });
      }
      return send(res, 200, { ok: true, sessionName });
    }

    send(res, 404, { error: "Not found" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 500, { error: message });
  }
}

export async function startServer(): Promise<{ port: number; close: () => Promise<void>; https: boolean }> {
  const cfg = await loadConfig();
  const port = cfg.n8n.servePort ?? 9090;
  const rawAuthToken = cfg.n8n.authToken;
  const webhookSecret = cfg.n8n.webhookSecret;

  // H-03: refuse to start without authToken unless explicit override.
  // The previous behaviour (warn + accept all callers) means any process
  // on localhost could POST /session/new and trigger spawnLoopDaemon →
  // claude with --dangerously-skip-permissions = full code-exec primitive.
  let authToken: string | null;
  if (rawAuthToken) {
    authToken = rawAuthToken;
  } else if (process.env.CCMUX_N8N_ALLOW_NOAUTH === "1") {
    console.warn("WARNING: CCMUX_N8N_ALLOW_NOAUTH=1 — /session/* endpoints are unauthenticated. Do NOT use this in shared environments.");
    authToken = null;
  } else {
    throw new Error(
      "n8n.authToken is required. Set it in config or pass CCMUX_N8N_ALLOW_NOAUTH=1 for local-only development.",
    );
  }

  if (!webhookSecret) {
    console.warn("WARNING: n8n.webhookSecret is not set. /webhook/github accepts unsigned payloads (BL-1).");
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handle(req, res, authToken, webhookSecret).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  };

  let server: http.Server | https.Server;
  let isHttps = false;

  if (cfg.n8n.tls) {
    const cert = await fs.readFile(cfg.n8n.tls.certFile, "utf-8");
    const key = await fs.readFile(cfg.n8n.tls.keyFile, "utf-8");
    server = https.createServer({ cert, key }, handler);
    isHttps = true;
  } else {
    server = http.createServer(handler);
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", resolve);
    server.once("error", reject);
  });

  return {
    port,
    https: isHttps,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
