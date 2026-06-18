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

// I-073: explicit allowlist of GitHub event types we act on. Anything outside
// the set is acknowledged with 200 (so GitHub stops redelivering) but ignored.
const ALLOWED_EVENTS = new Set<string>(["issues"]);

/**
 * I-071: In-memory LRU + TTL set for GitHub `X-GitHub-Delivery` GUIDs, to defend
 * against webhook *replay* (GitHub redelivery, n8n retry, manual resend) without
 * spawning a session twice. This is a fast first-line gate that sits in front of
 * the durable SQLite `claimSession` dedup — together they give defence in depth
 * (the LRU is per-process and bounded; the DB survives restarts).
 *
 * Bounded by both a size cap (oldest entry evicted on overflow) and a 24h TTL
 * (GitHub's own redelivery window), so a long-lived `serve` process can't leak
 * memory. Map preserves insertion order, so the first key is always the oldest.
 */
export class DeliveryDedup {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  /**
   * Record `id` as processed. Returns true if it was already seen (a replay),
   * false if this is the first time. Expired entries are treated as unseen.
   */
  checkAndAdd(id: string, now: number = Date.now()): boolean {
    const prev = this.seen.get(id);
    if (prev !== undefined) {
      if (now - prev < this.ttlMs) {
        // Refresh recency so an actively-replayed id stays hot (move to newest).
        this.seen.delete(id);
        this.seen.set(id, prev);
        return true;
      }
      // Expired — fall through and re-register as fresh.
      this.seen.delete(id);
    }

    this.evictExpired(now);
    this.seen.set(id, now);

    // Size cap: evict oldest (insertion-order front) until within bound.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  private evictExpired(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts < this.ttlMs) break; // insertion order ⇒ rest are newer
      this.seen.delete(key);
    }
  }

  /**
   * Forget a delivery-id so a legitimate redelivery can be processed again.
   * Used on the failure path (mirrors queue.releaseSession): if the work errored
   * we must NOT let the in-memory replay gate block GitHub's automatic retry.
   */
  remove(id: string): void {
    this.seen.delete(id);
  }

  /** Test helper: current tracked entry count. */
  get size(): number {
    return this.seen.size;
  }

  /** Test helper: drop all state. */
  clear(): void {
    this.seen.clear();
  }
}

// Module-level instance shared across all requests handled by this process.
export const deliveryDedup = new DeliveryDedup();

// Cap the request body so an unauthenticated client can't exhaust memory by
// streaming an unbounded POST — HMAC verification only happens after the body
// is fully read, so the limit must apply during reading.
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

function readBody(req: http.IncomingMessage): Promise<RawBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
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

// Neutralize request-derived values before logging so a crafted header can't
// forge log lines. encodeURIComponent percent-encodes CR/LF and other control
// characters and is recognized as a log-injection sanitizer (CodeQL
// js/log-injection); we cap length too. Normal values (event names, GUIDs) are
// left readable since their characters aren't encoded.
function sanitizeForLog(value: string): string {
  return encodeURIComponent(value.slice(0, 200));
}

function checkAuth(req: http.IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return false;
  // Constant-time comparison (matches verifyGitHubSignature) so the Bearer token
  // can't be recovered a character at a time via response-timing differences.
  const got = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${authToken}`);
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(got, expected);
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

export async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken: string | undefined,
  webhookSecret: string | undefined,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/health") {
    return send(res, 200, { ok: true });
  }

  // /webhook/github uses HMAC signature instead of Bearer auth.
  // All other endpoints require Bearer auth when authToken is set.
  const isWebhook = method === "POST" && url === "/webhook/github";
  if (!isWebhook && !checkAuth(req, authToken)) {
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
      // I-072 (fail-closed): authenticate BEFORE inspecting anything else.
      // Read the raw body first (HMAC must match the bytes as sent), then verify
      // the signature. No event-type/action branch may run on an unverified
      // request — otherwise unsigned payloads could observe behaviour differences
      // or be processed at all. Body is size-capped during read (MAX_BODY_BYTES).
      const { raw, json: body } = await readBody(req);

      // H-05 / CWE-807: the HMAC signature is MANDATORY. This endpoint triggers
      // a `--dangerously-skip-permissions` agent, so it must never act on
      // unauthenticated input. If no secret is configured we refuse outright
      // (the old "process unsigned payloads" mode was fail-open), and a
      // missing/invalid signature is rejected. Every path to autoCommand below
      // is therefore gated by a verified signature — the event/author/action
      // filters operate only on integrity-protected, authenticated data.
      if (!webhookSecret) {
        console.warn(
          "ccmux webhook: n8n.webhookSecret is not configured — refusing to process (request signing is required).",
        );
        return send(res, 503, { error: "webhook signing not configured" });
      }
      const sig = req.headers["x-hub-signature-256"];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      if (!verifyGitHubSignature(raw, sigStr, webhookSecret)) {
        console.warn("ccmux webhook: rejected request with invalid/missing signature");
        return send(res, 401, { error: "Invalid signature" });
      }

      // I-073: signature-verified — now apply the explicit event allowlist.
      // Unsupported events get 200 (not 4xx) so GitHub stops redelivering, but
      // we never act on them. Log the reason for observability.
      const rawEvent = req.headers["x-github-event"];
      const event = Array.isArray(rawEvent) ? rawEvent[0] : rawEvent;
      if (!event || !ALLOWED_EVENTS.has(event)) {
        console.warn(`ccmux webhook: ignoring unsupported event "${sanitizeForLog(event ?? "(none)")}"`);
        return send(res, 200, { ok: false, reason: "unsupported event" });
      }

      // I-071: replay defence. Dedup on the signed delivery GUID before doing
      // any work. A repeated delivery-id (GitHub redelivery / n8n retry) returns
      // 200 {dedup:true} without re-running autoCommand. Absent header ⇒ fall
      // through to the durable SQLite claim (which still dedups per session key).
      const rawDelivery = req.headers["x-github-delivery"];
      const deliveryId = Array.isArray(rawDelivery) ? rawDelivery[0] : rawDelivery;
      if (deliveryId && deliveryDedup.checkAndAdd(deliveryId)) {
        console.warn(`ccmux webhook: duplicate delivery ${sanitizeForLog(deliveryId)} ignored (replay)`);
        return send(res, 200, { ok: true, dedup: true, deliveryId });
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
        // re-trigger isn't permanently blocked by the dedup gate, and forget
        // the in-memory delivery-id so GitHub's automatic redelivery (which it
        // sends on our 5xx) can actually retry the work (I-071).
        releaseSession(sessionName);
        if (deliveryId) deliveryDedup.remove(deliveryId);
        // Log the detail server-side; return a generic message so internal
        // error/stack details aren't exposed to the HTTP caller (CodeQL
        // js/stack-trace-exposure).
        console.error(`ccmux webhook: autoCommand failed for ${sessionName}:`, cmdErr);
        return send(res, 500, { error: "internal error", sessionName });
      }
      return send(res, 200, { ok: true, sessionName });
    }

    send(res, 404, { error: "Not found" });
  } catch (err: unknown) {
    console.error("ccmux webhook handler error:", err);
    send(res, 500, { error: "internal error" });
  }
}

export interface ServerHandle {
  port: number;
  https: boolean;
  close: () => Promise<void>;
  /**
   * I-074: resolves (never rejects) when the server emits a runtime `error`
   * after a successful listen — e.g. an unrecoverable socket fault. Callers that
   * `await` it can shut down gracefully instead of hanging forever. If the server
   * is closed normally this promise simply never settles, which is fine: the
   * caller has already returned via its own shutdown path.
   */
  errored: Promise<Error>;
}

export async function startServer(portOverride?: number): Promise<ServerHandle> {
  const cfg = await loadConfig();
  const port = portOverride ?? cfg.n8n.servePort ?? 9090;
  const authToken = cfg.n8n.authToken;
  const webhookSecret = cfg.n8n.webhookSecret;

  if (!authToken) {
    console.warn("WARNING: n8n.authToken is not set. /session/* endpoints are unauthenticated.");
  }
  if (!webhookSecret) {
    console.warn("WARNING: n8n.webhookSecret is not set. /webhook/github will REJECT every request (503) until it is configured — signing is required.");
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handle(req, res, authToken, webhookSecret).catch((err: unknown) => {
      console.error("ccmux webhook handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
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

  // During startup, a `listen` error (EADDRINUSE, EACCES, …) rejects the boot
  // promise. We remove this one-shot listener once listening succeeds so it
  // doesn't double-handle with the persistent runtime handler below.
  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once("error", onListenError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  // Resolve the *actual* bound port: when port 0 is requested (ephemeral, used
  // by tests) the OS assigns a real port that we must report back rather than 0.
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  // I-074: keep a persistent error handler installed for the life of the server.
  // Without it a post-listen runtime `error` would crash the process (unhandled
  // 'error' event) or, with serve.ts's old infinite Promise, hang forever. We
  // log, flag a non-zero exit code, and surface the error via `errored` so the
  // owner of the handle can shut down gracefully.
  const errored = new Promise<Error>((resolve) => {
    server.on("error", (err: Error) => {
      console.error("ccmux serve: fatal server error:", err);
      process.exitCode = 1;
      resolve(err);
    });
  });

  return {
    port: boundPort,
    https: isHttps,
    errored,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
