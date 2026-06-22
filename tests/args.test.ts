import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { intArg } from "../src/core/args.js";

describe("intArg", () => {
  it("parses a valid integer", () => {
    expect(intArg()("42")).toBe(42);
  });

  it("ignores the previousValue commander passes as the 2nd argument", () => {
    // Regression for the parseInt-radix bug: commander calls a coercion as
    // `fn(value, previous)`. Passing `parseInt` directly meant `parseInt("8", 50)`
    // — the default/previous became the radix and produced NaN. intArg must
    // ignore the second argument entirely.
    expect(intArg()("8", 50)).toBe(8);
    expect(intArg()("10", "30")).toBe(10);
  });

  it("rejects non-numeric input", () => {
    expect(() => intArg()("abc")).toThrow(InvalidArgumentError);
    expect(() => intArg()("")).toThrow(InvalidArgumentError);
    expect(() => intArg()("12px")).toThrow(InvalidArgumentError);
  });

  it("rejects floats", () => {
    expect(() => intArg()("1.5")).toThrow(InvalidArgumentError);
  });

  it("enforces the inclusive minimum", () => {
    expect(() => intArg(1)("0")).toThrow(/>= 1/);
    expect(intArg(1)("1")).toBe(1);
  });

  it("enforces the inclusive maximum", () => {
    expect(() => intArg(1, 65535)("65536")).toThrow(/<= 65535/);
    expect(intArg(1, 65535)("65535")).toBe(65535);
  });

  it("rejects unsafe integers", () => {
    expect(() => intArg()("99999999999999999999")).toThrow(/too large/);
  });
});
