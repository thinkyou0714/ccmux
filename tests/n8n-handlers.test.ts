import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import http from "http";
import crypto from "crypto";

// Exercises the n8n webhook server's request dispatcher (handle()) end-to-end
// over a real loopback socket — the auth/routing/validation/dedup gates that
// verifyGitHubSignature unit tests don't reach. Every case asserted here
// returns BEFORE newCommand/autoCommand, so no worktree/agent is ever spawned.

let tmp: string;
const origEnv = { ...process.env };

interface Resp {
  status?: number;
  json?: unknown;
  error?: boolean;
}

/** Fire one request at the loopback server. Never rejects: a socket error
 *  (e.g. the oversize guard destroying the connection) resolves to {error:true}
 *  so tests can assert on it deterministically. */
function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: opts.headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", () => resolve({ error: true }));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface N8nConfig {
  authToken?: string;
  webhookSecret?: string;
}

/** Write a config.json into the temp CCMUX_DIR and start a fresh server on an
 *  ephemeral port. Returns the bound port + a close fn. */
async function start(n8n: N8nConfig): Promise<{ port: number; close: () => Promise<void> }> {
  await fs.writeFile(path.join(tmp, "config.json"), JSON.stringify({ n8n }), "utf-8");
  const { startServer } = await import("../src/integrations/n8n.js");
  const srv = await startServer(0);
  return { port: srv.port, close: srv.close };
}

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

beforeEach(async () => {
  vi.resetModules(); // fresh module-level config + queue handle per test
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-n8n-handlers-"));
  process.env.CCMUX_DIR = tmp;
  // Silence the startServer "authToken/webhookSecret not set" warnings.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("n8n handler — health & auth", () => {
  it("GET /health returns 200 even when an authToken is configured", async () => {
    const { port, close } = await start({ authToken: "secret-token" });
    try {
      const r = await request(port, "GET", "/health");
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it("401s a protected route when the Bearer token is missing", async () => {
    const { port, close } = await start({ authToken: "secret-token" });
    try {
      const r = await request(port, "GET", "/session/list");
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("allows a protected route with the correct Bearer token", async () => {
    const { port, close } = await start({ authToken: "secret-token" });
    try {
      const r = await request(port, "GET", "/session/list", {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ sessions: expect.any(Array) });
    } finally {
      await close();
    }
  });
});

describe("n8n handler — /session/* validation", () => {
  it("400s when name is missing", async () => {
    const { port, close } = await start({ authToken: "t" });
    try {
      const r = await request(port, "POST", "/session/new", {
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ project: "x" }),
      });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("400s a path-traversal session name (never reaches newCommand)", async () => {
    const { port, close } = await start({ authToken: "t" });
    try {
      const r = await request(port, "POST", "/session/new", {
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ name: "../../etc/evil" }),
      });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("refuses an over-sized request body (oversize guard)", async () => {
    const { port, close } = await start({ authToken: "t" });
    try {
      const r = await request(port, "POST", "/session/new", {
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          // Declared length far above the 1 MiB cap → rejected before any body read.
          "content-length": String(2 * 1024 * 1024),
        },
        body: JSON.stringify({ name: "ok" }),
      });
      // Either the socket is destroyed (error) or a 413 is mapped — never a 2xx.
      expect(r.error === true || r.status === 413).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("n8n handler — /webhook/github gates", () => {
  const secret = "webhook-shh";

  it("503s when no webhook secret is configured (fail closed)", async () => {
    const { port, close } = await start({}); // no webhookSecret
    try {
      const r = await request(port, "POST", "/webhook/github", {
        headers: { "content-type": "application/json", "x-github-event": "issues" },
        body: JSON.stringify({ action: "opened", issue: { number: 1, title: "x" } }),
      });
      expect(r.status).toBe(503);
    } finally {
      await close();
    }
  });

  it("401s an invalid signature", async () => {
    const { port, close } = await start({ webhookSecret: secret });
    try {
      const body = JSON.stringify({ action: "opened", issue: { number: 1, title: "x" } });
      const r = await request(port, "POST", "/webhook/github", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body,
      });
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("ignores a non-issues event with a valid signature", async () => {
    const { port, close } = await start({ webhookSecret: secret });
    try {
      const body = JSON.stringify({ action: "opened" });
      const r = await request(port, "POST", "/webhook/github", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": sign(body, secret),
        },
        body,
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: false, reason: "not an issues event" });
    } finally {
      await close();
    }
  });

  it("ignores a non-opened issues action with a valid signature", async () => {
    const { port, close } = await start({ webhookSecret: secret });
    try {
      const body = JSON.stringify({ action: "edited", issue: { number: 2, title: "x" } });
      const r = await request(port, "POST", "/webhook/github", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign(body, secret),
        },
        body,
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: false, reason: "not an opened action" });
    } finally {
      await close();
    }
  });

  it("400s an opened issues event missing the issue payload", async () => {
    const { port, close } = await start({ webhookSecret: secret });
    try {
      const body = JSON.stringify({ action: "opened" });
      const r = await request(port, "POST", "/webhook/github", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign(body, secret),
        },
        body,
      });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("dedups a re-delivered issue without spawning (claim already held)", async () => {
    const { port, close } = await start({ webhookSecret: secret });
    const { claimSession, _closeDbForTests } = await import("../src/core/queue.js");
    try {
      // Pre-claim the key so the handler's INSERT-OR-IGNORE sees changes=0.
      expect(claimSession("issue-7", "test").claimed).toBe(true);

      const body = JSON.stringify({ action: "opened", issue: { number: 7, title: "dup" } });
      const r = await request(port, "POST", "/webhook/github", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign(body, secret),
        },
        body,
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, dedup: true, sessionName: "issue-7" });
    } finally {
      _closeDbForTests();
      await close();
    }
  });
});
