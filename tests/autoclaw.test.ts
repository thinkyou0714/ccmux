import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  buildClaudeEnv,
  resolveClaudeCmd,
  resolveClaudeModel,
  checkHealth,
  routeTask,
} from "../src/integrations/autoclaw.js";
import { invalidateConfigCache, type CcmuxConfig } from "../src/config/schema.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-autoclaw-"));
  process.env.CCMUX_DIR = tmp;
  invalidateConfigCache();
});

afterEach(async () => {
  process.env = { ...origEnv };
  invalidateConfigCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeConfig(autoclaw: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(tmp, "config.json"), JSON.stringify({ autoclaw }));
  invalidateConfigCache();
}

/** A one-request loopback stub standing in for the autoclaw/LiteLLM proxy. */
function startStub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ port: number; close: () => Promise<void>; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastAuth = req.headers["authorization"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf-8")));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
        lastAuth: () => lastAuth,
      });
    });
  });
}

describe("buildClaudeEnv (pure)", () => {
  const cfg = { autoclaw: { url: "http://proxy:9/task", authToken: "tok" } } as unknown as CcmuxConfig;

  // buildClaudeEnv clones process.env; clear any inherited ANTHROPIC_* so the
  // function's own additions are observable (the CI/agent env may set them).
  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("leaves ANTHROPIC_* unset for the plain claude backend", () => {
    const env = buildClaudeEnv("claude", cfg);
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("injects base URL + auth token for the autoclaw backend and stamps the session", () => {
    const env = buildClaudeEnv("autoclaw", cfg, "sess-1");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://proxy:9/task");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok");
    expect(env["CCMUX_SESSION"]).toBe("sess-1");
  });

  it("omits the auth token when none is configured", () => {
    const env = buildClaudeEnv("autoclaw", { autoclaw: { url: "http://p/t" } } as unknown as CcmuxConfig);
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });
});

describe("resolveClaudeCmd / resolveClaudeModel", () => {
  it("returns bare 'claude' for the claude backend", async () => {
    await writeConfig({ url: "http://x/t", model: "m" });
    expect(await resolveClaudeCmd("claude")).toBe("claude");
    expect(await resolveClaudeModel("claude")).toBeUndefined();
  });

  it("prefixes ANTHROPIC_BASE_URL and appends --model for autoclaw", async () => {
    await writeConfig({ url: "http://x/t", model: "qwen3-coder" });
    expect(await resolveClaudeCmd("autoclaw")).toBe('ANTHROPIC_BASE_URL="http://x/t" claude --model qwen3-coder');
    expect(await resolveClaudeModel("autoclaw")).toBe("qwen3-coder");
  });
});

describe("checkHealth", () => {
  it("reports available with latency on a 200 /health", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/health") res.writeHead(200).end("{}");
      else res.writeHead(404).end();
    });
    try {
      await writeConfig({ url: `http://127.0.0.1:${stub.port}/task` });
      const h = await checkHealth();
      expect(h.available).toBe(true);
      expect(typeof h.latencyMs).toBe("number");
    } finally {
      await stub.close();
    }
  });

  it("reports unavailable when the proxy is unreachable", async () => {
    // Bind then immediately close to obtain a certainly-dead port.
    const stub = await startStub(() => {});
    const deadPort = stub.port;
    await stub.close();
    await writeConfig({ url: `http://127.0.0.1:${deadPort}/task` });
    const h = await checkHealth();
    expect(h.available).toBe(false);
    expect(h.error).toBeDefined();
  });

  it("reports an invalid configured URL without throwing", async () => {
    await writeConfig({ url: "not a url" });
    const h = await checkHealth();
    expect(h.available).toBe(false);
  });
});

describe("routeTask", () => {
  it("POSTs the prompt and extracts the task id, sending the auth header", async () => {
    let seenBody = "";
    const stub = await startStub((_req, res, body) => {
      seenBody = body;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ task_id: "t-123" }));
    });
    try {
      await writeConfig({ url: `http://127.0.0.1:${stub.port}/task`, authToken: "secret" });
      const { taskId } = await routeTask("do the thing");
      expect(taskId).toBe("t-123");
      expect(JSON.parse(seenBody)).toEqual({ prompt: "do the thing" });
      expect(stub.lastAuth()).toBe("Bearer secret");
    } finally {
      await stub.close();
    }
  });

  it("rejects on a non-2xx response", async () => {
    const stub = await startStub((_req, res) => res.writeHead(500).end("boom"));
    try {
      await writeConfig({ url: `http://127.0.0.1:${stub.port}/task` });
      await expect(routeTask("x")).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });
});
