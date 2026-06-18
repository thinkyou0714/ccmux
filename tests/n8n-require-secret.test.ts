import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";

// H-05: /webhook/github must REFUSE to act when no webhookSecret is configured
// (the old fail-open "process unsigned" mode let unauthenticated input spawn a
// --dangerously-skip-permissions agent). Mock the heavy layers so we observe
// only the handler's gate.
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

const origEnv = { ...process.env };
let server: { port: number; close: () => Promise<void> };
let configDir: string;

function post(port: number, body: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/webhook/github", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }));
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
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-nosecret-"));
  process.env.CCMUX_DIR = configDir;
  process.env.HOME = configDir;
  // Config WITHOUT a webhookSecret.
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ version: 1, n8n: { enabled: true } }), "utf-8");
  const n8n = await import("../src/integrations/n8n.js");
  server = await n8n.startServer(0);
});

afterEach(async () => {
  await server.close();
  process.env = { ...origEnv };
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("webhook mandatory signing (H-05)", () => {
  const body = JSON.stringify({ action: "opened", issue: { number: 1, title: "x" } });

  it("returns 503 and does not spawn an agent when no webhookSecret is configured", async () => {
    const r = await post(server.port, body, { "x-github-event": "issues" });
    expect(r.status).toBe(503);
    expect(mocks.autoCommand).not.toHaveBeenCalled();
    expect(mocks.claimSession).not.toHaveBeenCalled();
  });
});
