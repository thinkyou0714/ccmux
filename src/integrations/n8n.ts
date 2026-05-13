import http from "http";
import https from "https";
import fs from "fs/promises";
import { loadConfig } from "../config/schema.js";
import { newCommand } from "../commands/new.js";
import { closeCommand } from "../commands/close.js";
import { listSessions } from "../core/session.js";
import { autoCommand } from "../commands/auto.js";

type JsonBody = Record<string, unknown>;

function readBody(req: http.IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function checkAuth(req: http.IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  const header = req.headers["authorization"];
  if (!header) return false;
  return header === `Bearer ${authToken}`;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, authToken: string | undefined): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (!checkAuth(req, authToken)) {
    return send(res, 401, { error: "Unauthorized" });
  }

  try {
    if (method === "GET" && url === "/session/list") {
      const sessions = await listSessions();
      return send(res, 200, { sessions });
    }

    if (method === "POST" && url === "/session/new") {
      const body = await readBody(req);
      const name = body.name as string | undefined;
      const project = body.project as string | undefined;
      const llm = (body.llm as "claude" | "autoclaw" | undefined) ?? "claude";

      if (!name) return send(res, 400, { error: "name is required" });

      await newCommand(name, { project, llm });
      return send(res, 201, { ok: true, name });
    }

    if (method === "POST" && url === "/session/close") {
      const body = await readBody(req);
      const name = body.name as string | undefined;
      if (!name) return send(res, 400, { error: "name is required" });

      await closeCommand(name, {});
      return send(res, 200, { ok: true, name });
    }

    if (method === "POST" && url === "/webhook/github") {
      const event = req.headers["x-github-event"];
      if (event !== "issues") {
        return send(res, 200, { ok: false, reason: "not an issues event" });
      }

      const body = await readBody(req);
      const action = body.action as string | undefined;
      if (action !== "opened") {
        return send(res, 200, { ok: false, reason: "not an opened action" });
      }

      const issue = body.issue as { number: number; title: string; body?: string } | undefined;
      if (!issue) return send(res, 400, { error: "issue payload missing" });

      const sessionName = `issue-${issue.number}`;
      const prompt = `Issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ""}`;

      try {
        await autoCommand(sessionName, { prompt });
      } catch (cmdErr: unknown) {
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
  const authToken = cfg.n8n.authToken;

  if (!authToken) {
    console.warn("WARNING: n8n.authToken is not set. All endpoints are unauthenticated.");
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handle(req, res, authToken).catch((err: unknown) => {
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
