import http from "http";

export interface MockLLMServer {
  port: number;
  url: string;
  requestCount(): number;
  close(): Promise<void>;
}

/**
 * Stub HTTP server that emulates a minimal Anthropic /v1/messages endpoint.
 * Used by integration tests so ccmux auto can spawn `claude` and (when claude
 * is also stubbed/skipped) we can at least assert that the auto→worktree→hook
 * scaffolding works without a real LLM in the loop.
 *
 * Reply shape is intentionally tiny: 1 assistant message with the literal
 * text "CCMUX_COMPLETE" so loop-mode also terminates on the first iteration.
 */
export async function startMockLLM(): Promise<MockLLMServer> {
  let requests = 0;

  const server = http.createServer((req, res) => {
    requests++;
    // Drain body to satisfy keep-alive clients; we don't actually parse it.
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", mock: true }));
        return;
      }
      // Default: Anthropic-style response.
      const body = JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "mock-llm",
        content: [{ type: "text", text: "CCMUX_COMPLETE" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 3 },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock LLM server failed to bind a port");
  }
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requestCount: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
