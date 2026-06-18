import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";

// I-081: routeTask must not buffer an unbounded response. We drive it against a
// local stub HTTP server whose URL we inject via a temp CCMUX_DIR/config.json.
// loadConfig() memoises its result, so each test resets the module registry and
// re-imports routeTask to get a fresh (uncached) config bound to that test's
// stub server port.

const origEnv = { ...process.env };
let tmp: string;
let server: http.Server;
let port: number;

/** Per-request behaviour for the stub, set by each test before calling routeTask. */
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Fresh routeTask whose loadConfig cache is empty and sees this test's config. */
async function freshRouteTask(): Promise<typeof import("../src/integrations/autoclaw.js").routeTask> {
  vi.resetModules();
  const mod = await import("../src/integrations/autoclaw.js");
  return mod.routeTask;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-route-"));
  process.env.CCMUX_DIR = tmp;

  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no server address");
  port = addr.port;

  await fs.writeFile(
    path.join(tmp, "config.json"),
    JSON.stringify({ autoclaw: { url: `http://127.0.0.1:${port}/task` } }),
    "utf-8",
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = { ...origEnv };
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("I-081 routeTask response handling", () => {
  it("returns the task id from a small JSON response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task_id: "abc-123" }));
    };
    const routeTask = await freshRouteTask();
    const { taskId } = await routeTask("do a thing");
    expect(taskId).toBe("abc-123");
  });

  it("accepts the `id` field as an alias for task_id", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ id: "id-777" }));
    };
    const routeTask = await freshRouteTask();
    expect((await routeTask("x")).taskId).toBe("id-777");
  });

  it("resolves taskId 'unknown' for a 2xx response with non-JSON body", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("not json");
    };
    const routeTask = await freshRouteTask();
    expect((await routeTask("x")).taskId).toBe("unknown");
  });

  it("rejects on a non-2xx status without leaking the body", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("internal secret detail");
    };
    const routeTask = await freshRouteTask();
    await expect(routeTask("x")).rejects.toThrow(/HTTP 500/);
    // The upstream body must not be embedded in the error message.
    await expect(routeTask("x")).rejects.not.toThrow(/secret detail/);
  });

  it("rejects and aborts when the response exceeds the 1MiB cap", async () => {
    // Stream well over 1 MiB so the size guard trips mid-stream.
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(256 * 1024, 0x61); // 256 KiB of 'a'
      let sent = 0;
      const pump = (): void => {
        // 8 * 256KiB = 2 MiB, comfortably past the 1 MiB limit.
        if (sent >= 8 || res.writableEnded) {
          if (!res.writableEnded) res.end();
          return;
        }
        sent++;
        if (res.write(chunk)) {
          setImmediate(pump);
        } else {
          res.once("drain", pump);
        }
      };
      pump();
    };
    const routeTask = await freshRouteTask();
    await expect(routeTask("x")).rejects.toThrow(/exceeded .* bytes/);
  });

  it("does not split multi-byte UTF-8 across chunk boundaries", async () => {
    // The task id is built from a multi-byte string delivered in two TCP writes
    // that bisect a 3-byte character. Buffer.concat + single decode must recover it.
    const multibyte = "あ".repeat(100); // each 'あ' is 3 bytes in UTF-8
    const payload = Buffer.from(JSON.stringify({ task_id: multibyte }), "utf-8");
    const splitAt = 20; // lands inside a multi-byte sequence
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(payload.subarray(0, splitAt));
      setImmediate(() => res.end(payload.subarray(splitAt)));
    };
    const routeTask = await freshRouteTask();
    expect((await routeTask("x")).taskId).toBe(multibyte);
  });
});
