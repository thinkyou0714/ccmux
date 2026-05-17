import { describe, it, expect } from "vitest";
import http from "http";
import { startMockLLM } from "./mock-llm-server.js";

/**
 * Smoke test for the mock LLM helper. Confirms it serves both /health and a
 * plausible Anthropic-shaped reply so downstream integration tests can build
 * on it confidently.
 */
describe("integration: mock LLM server", () => {
  it("responds to /health with status ok", async () => {
    const srv = await startMockLLM();
    try {
      const text = await fetchText(`${srv.url}/health`);
      const json = JSON.parse(text);
      expect(json.status).toBe("ok");
      expect(json.mock).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("returns an Anthropic-style message with CCMUX_COMPLETE", async () => {
    const srv = await startMockLLM();
    try {
      const text = await fetchText(`${srv.url}/v1/messages`, "POST", '{"model":"x","messages":[]}');
      const json = JSON.parse(text);
      expect(json.type).toBe("message");
      expect(json.role).toBe("assistant");
      expect(json.content[0].text).toBe("CCMUX_COMPLETE");
      expect(srv.requestCount()).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

function fetchText(url: string, method = "GET", body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
