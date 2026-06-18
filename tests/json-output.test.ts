import { describe, it, expect, vi } from "vitest";
import { jsonOk, jsonErr, printJson, type JsonEnvelope } from "../src/core/json-output.js";

// I-099: the envelope is a public contract for every --json consumer, so pin
// its shape (schema_version, the data/error duality, warnings-always-array, and
// the meta breadcrumbs) at the unit level rather than only via command e2e.

describe("json-output envelope (I-099)", () => {
  it("jsonOk sets data and leaves error null", () => {
    const env = jsonOk({ hello: "world" });
    expect(env.schema_version).toBe("1");
    expect(env.data).toEqual({ hello: "world" });
    expect(env.error).toBeNull();
    expect(env.warnings).toEqual([]);
    expect(env.meta).toEqual({});
  });

  it("jsonErr sets error and leaves data null", () => {
    const env = jsonErr("boom");
    expect(env.schema_version).toBe("1");
    expect(env.data).toBeNull();
    expect(env.error).toBe("boom");
    expect(env.warnings).toEqual([]);
  });

  it("warnings is always an array even when omitted", () => {
    expect(jsonOk(1).warnings).toEqual([]);
    expect(jsonErr("x").warnings).toEqual([]);
  });

  it("carries supplied warnings through", () => {
    const env = jsonOk(null, { warnings: ["a", "b"] });
    expect(env.warnings).toEqual(["a", "b"]);
  });

  it("command option injects meta.command and an ISO meta.ts", () => {
    const env = jsonOk([], { command: "list" });
    expect(env.meta.command).toBe("list");
    expect(typeof env.meta.ts).toBe("string");
    // round-trips as a valid ISO timestamp
    expect(new Date(env.meta.ts as string).toISOString()).toBe(env.meta.ts);
  });

  it("explicit meta merges with (and can override) the command breadcrumbs", () => {
    const env = jsonOk(1, { command: "doctor", meta: { ts: "2020-01-01T00:00:00.000Z", extra: 7 } });
    expect(env.meta.command).toBe("doctor");
    expect(env.meta.ts).toBe("2020-01-01T00:00:00.000Z");
    expect(env.meta.extra).toBe(7);
  });

  it("meta without command is passed through verbatim (no ts injected)", () => {
    const env = jsonOk(1, { meta: { only: "this" } });
    expect(env.meta).toEqual({ only: "this" });
  });

  it("printJson writes one newline-terminated line of JSON to stdout", () => {
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString("utf-8");
      return true;
    }) as typeof process.stdout.write);
    try {
      const env: JsonEnvelope<{ n: number }> = jsonOk({ n: 1 }, { command: "test" });
      printJson(env);
    } finally {
      spy.mockRestore();
    }
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed.data).toEqual({ n: 1 });
    expect(parsed.meta.command).toBe("test");
  });
});
