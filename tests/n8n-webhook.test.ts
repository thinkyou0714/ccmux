import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Stable mock fns that survive vi.resetModules() (hoisted refs). We mock the
// heavy command + durable-queue layers so these tests observe *handler*
// behaviour (signature-first ordering, event allowlist, replay dedup) without
// spawning worktrees or touching SQLite. claimSession always "wins", so the
// in-memory LRU (I-071) is the only thing that can short-circuit a 2nd call.
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

const SECRET = "webhook-test-secret";
const origEnv = { ...process.env };

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

interface Resp {
  status: number;
  json: Record<string, unknown>;
}

let server: { port: number; close: () => Promise<void> };
// Reference to the live module's dedup so we can clear it between tests.
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

beforeEach(async () => {
  vi.resetModules();
  mocks.autoCommand.mockClear();
  mocks.claimSession.mockClear();
  mocks.releaseSession.mockClear();

  // Boot the server in signed-webhook mode via a temp config dir.
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-webhook-"));
  process.env.CCMUX_DIR = configDir;
  process.env.HOME = configDir;
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ version: 1, n8n: { webhookSecret: SECRET } }),
    "utf-8",
  );

  const n8n = await import("../src/integrations/n8n.js");
  deliveryDedup = n8n.deliveryDedup as unknown as { clear(): void; size: number };
  deliveryDedup.clear();
  server = await n8n.startServer(0);
});

afterEach(async () => {
  await server.close();
  process.env = { ...origEnv };
  await fs.rm(configDir, { recursive: true, force: true });
});

const issueBody = JSON.stringify({ action: "opened", issue: { number: 42, title: "Bug" } });

describe("webhook fail-closed signature gate (I-072)", () => {
  it("rejects an unsigned request with 401 before any event/action branch", async () => {
    const r = await postWebhook(server.port, issueBody, { "x-github-event": "issues" });
    expect(r.status).toBe(401);
    expect(mocks.autoCommand).not.toHaveBeenCalled();
    expect(mocks.claimSession).not.toHaveBeenCalled();
  });

  it("rejects a bad-signature request even for a non-issues event (no fail-open)", async () => {
    // Previously a non-"issues" event short-circuited to 200 *before* signature
    // verification — an unsigned client could probe event handling. Now 401.
    const r = await postWebhook(server.port, issueBody, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(issueBody, "wrong-secret"),
    });
    expect(r.status).toBe(401);
    expect(mocks.autoCommand).not.toHaveBeenCalled();
  });

  it("accepts a valid signature and processes an opened issue", async () => {
    const r = await postWebhook(server.port, issueBody, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(issueBody, SECRET),
      "x-github-delivery": "delivery-ok-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.sessionName).toBe("issue-42");
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);
  });
});

describe("webhook event allowlist (I-073)", () => {
  it("returns 200 {ok:false, reason:'unsupported event'} for a signed non-allowed event", async () => {
    const r = await postWebhook(server.port, issueBody, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(issueBody, SECRET),
      "x-github-delivery": "delivery-pr-1",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("unsupported event");
    expect(mocks.autoCommand).not.toHaveBeenCalled();
  });

  it("returns 200 unsupported when the event header is absent (but signed)", async () => {
    const r = await postWebhook(server.port, issueBody, {
      "x-hub-signature-256": sign(issueBody, SECRET),
    });
    expect(r.status).toBe(200);
    expect(r.json.reason).toBe("unsupported event");
    expect(mocks.autoCommand).not.toHaveBeenCalled();
  });
});

describe("webhook delivery-id replay dedup (I-071)", () => {
  it("2nd request with same X-GitHub-Delivery returns dedup:true and does not re-run autoCommand", async () => {
    const headers = {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(issueBody, SECRET),
      "x-github-delivery": "delivery-replay-1",
    };
    const first = await postWebhook(server.port, issueBody, headers);
    expect(first.status).toBe(200);
    expect(first.json.dedup).toBeUndefined();
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);

    const second = await postWebhook(server.port, issueBody, headers);
    expect(second.status).toBe(200);
    expect(second.json.dedup).toBe(true);
    expect(second.json.deliveryId).toBe("delivery-replay-1");
    // autoCommand NOT called a second time.
    expect(mocks.autoCommand).toHaveBeenCalledTimes(1);
  });

  it("requests without a delivery-id header are not deduped by the LRU", async () => {
    const headers = {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(issueBody, SECRET),
    };
    const first = await postWebhook(server.port, issueBody, headers);
    expect(first.json.dedup).toBeUndefined();
    const second = await postWebhook(server.port, issueBody, headers);
    // No delivery-id ⇒ LRU can't dedup; falls through to claimSession (mocked to
    // always win), so autoCommand runs both times.
    expect(second.json.dedup).toBeUndefined();
    expect(mocks.autoCommand).toHaveBeenCalledTimes(2);
  });

  it("a failed delivery is forgotten so GitHub's redelivery can retry (not deduped)", async () => {
    const headers = {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(issueBody, SECRET),
      "x-github-delivery": "delivery-fail-1",
    };
    // First attempt fails inside autoCommand ⇒ 500, and the delivery-id is
    // released from the replay gate.
    mocks.autoCommand.mockRejectedValueOnce(new Error("boom"));
    const first = await postWebhook(server.port, issueBody, headers);
    expect(first.status).toBe(500);
    expect(mocks.releaseSession).toHaveBeenCalledWith("issue-42");

    // Redelivery of the SAME id is processed again (not dedup:true).
    const second = await postWebhook(server.port, issueBody, headers);
    expect(second.json.dedup).toBeUndefined();
    expect(second.status).toBe(200);
    expect(mocks.autoCommand).toHaveBeenCalledTimes(2);
  });
});
