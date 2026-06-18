import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { intArg, validateSessionName } from "../src/core/args.js";

describe("intArg", () => {
  it("parses base-10 integers regardless of the commander previousValue arg", () => {
    const parse = intArg();
    // commander calls coercion(value, previousValue); the 2nd arg must NOT be
    // treated as a radix (the parseInt footgun this replaces).
    expect((parse as (v: string, p?: unknown) => number)("8", 50)).toBe(8);
    expect(parse("11")).toBe(11);
    expect(parse("0")).toBe(0);
  });

  it("rejects non-integers", () => {
    const parse = intArg();
    for (const bad of ["abc", "99.9", "", "  ", "8abc", "0x10"]) {
      expect(() => parse(bad)).toThrow(InvalidArgumentError);
    }
  });

  it("enforces min/max bounds", () => {
    const port = intArg(1, 65535);
    expect(port("9090")).toBe(9090);
    expect(() => port("0")).toThrow(/>= 1/);
    expect(() => port("70000")).toThrow(/<= 65535/);
    expect(() => intArg(1)("0")).toThrow(/>= 1/);
  });
});

describe("validateSessionName", () => {
  it("accepts safe names", () => {
    for (const ok of ["feature", "fix-123", "a", "A1._-", "x".repeat(64)]) {
      expect(() => validateSessionName(ok)).not.toThrow();
    }
  });

  it("rejects traversal / unsafe / empty names", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "../etc",
      "a/b",
      "a..b",
      "-leading",
      ".leading",
      "with space",
      "x".repeat(65),
      "name;rm -rf",
      'a"b',
    ]) {
      expect(() => validateSessionName(bad)).toThrow(InvalidArgumentError);
    }
  });
});
