import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

// I-095: opt-in issue-author allowlist. When n8n.allowedAuthors is set, only
// issues opened by a listed author spawn an agent; everyone else gets a 200
// {ok:false, reason:"author not allowed"} with no autoCommand. When the list is
// absent, behaviour is unchanged (every author processed).
//
// We mock the command + queue layers (same pattern as n8n-webhook.test.ts) so
// the test observes *handler* gating, not real worktrees/SQLite.
const mocks = vi.hoisted(() => ({
  autoCommand: vi.fn(async () => {}),
  claimSession: vi.fn(() => ({ claimed: true })),
  releaseSession: vi.fn(() => {}),
  completeSession: vi.fn(() => {}),
}));

vi.mock("../src/commands/auto.js", () => ({ autoCommand: mocks.autoCommand }));
vi.mock("../src/core/queue.js", () => ({
  claimSession: mocks.claimSession,
  releaseSession: mocks.releaseSession,
  completeSession: mocks.completeSession,
}));

const SECRET = "author-test-secret";
const origEnv = { ...process.env };

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

interface Resp {
  status: number;
  json: Record<string, unknown>;
}

let server: { port: number; close: () => Promise<void> };
let deliveryDedup: { clear(): void; size: number };
let configDir: string;

function postWebhook(
  port: number,
  body: string,
  headers: Record<string, string | undefined>,
): Promise<Resp> {
  const hdrs: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) hdrs[k] = v;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/webhook/github", method: "POST", headers: hdrs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Boot a fresh server with the given n8n config fragment merged in.
async function boot(n8nExtra: Record<string, unknown>): Promise<void> {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-author-"));
  process.env.CCMUX_DIR = configDir;
  process.env.HOME = configDir;
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ version: 1, n8n: { webhookSecret: SECRET, ...n8nExtra } }),
    "utf-8",
  );
  vi.resetModules();
  const n8n = await import("../src/integrations/n8n.js");
  deliveryDedup = n8n.deliveryDedup as unknown as { clear(): void; size: number };
  deliveryDedup.clear();
  server = await n8n.startServer(0);
}

beforeEach(() => {
  mocks.autoCommand.mockClear();
  mocks.claimSession.mockClear();
  mocks.releaseSession.mockClear();
});

afterEach(async () => {
  if (server) await server.close();
  process.env = { ...origEnv };
  if (configDir) await fs.rm(configDir, { recursive: true, force: true });
});

function issuePayload(author: string): string {
  return JSON.stringify({
    action: "opened",
    issue: { number: 7, title: "Bug", user: { login: author } },
    sender: { login: author },
  });
}

describe("webhook issue-author allowlist (I-095)", () => {
  it("processes any author when allowedAuthors is unset (legacy behaviour)", async () => {
    await boot({}); // no allowedAuthors
    const body = issuePayload("random-person");
    const r = await postWebhook(server.port, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "d-unset-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.sessionName).toBe("issue-7");
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects an author not in allowedAuthors (200 ok:false, no autoCommand)", async () => {
    await boot({ allowedAuthors: ["alice", "bob"] });
    const body = issuePayload("mallory");
    const r = await postWebhook(server.port, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "d-deny-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("author not allowed");
    expect(mocks.autoCommand).not.toHaveBeenCalled();
    expect(mocks.claimSession).not.toHaveBeenCalled();
  });

  it("processes an author that IS in allowedAuthors", async () => {
    await boot({ allowedAuthors: ["alice", "bob"] });
    const body = issuePayload("alice");
    const r = await postWebhook(server.port, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "d-allow-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.sessionName).toBe("issue-7");
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);
  });

  it("falls back to sender.login when issue.user.login is absent", async () => {
    await boot({ allowedAuthors: ["carol"] });
    const body = JSON.stringify({
      action: "opened",
      issue: { number: 9, title: "No user field" },
      sender: { login: "carol" },
    });
    const r = await postWebhook(server.port, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "d-sender-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects when allowlist is set but no author can be extracted", async () => {
    await boot({ allowedAuthors: ["dave"] });
    const body = JSON.stringify({
      action: "opened",
      issue: { number: 11, title: "No author anywhere" },
    });
    const r = await postWebhook(server.port, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
      "x-github-delivery": "d-noauthor-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.reason).toBe("author not allowed");
    expect(mocks.autoCommand).not.toHaveBeenCalled();
  });
});
