import { describe, it, expect } from "vitest";
import { redactSecret } from "../src/core/redact.js";

// I-097: redactSecret keeps enough to recognise a secret without printing it.
describe("redactSecret (I-097)", () => {
  it("returns (unset) for undefined", () => {
    expect(redactSecret(undefined)).toBe("(unset)");
  });

  it("returns (unset) for an empty string", () => {
    expect(redactSecret("")).toBe("(unset)");
  });

  it("fully masks short secrets (<= 4 chars) so nothing leaks", () => {
    expect(redactSecret("a")).toBe("***");
    expect(redactSecret("ab")).toBe("***");
    expect(redactSecret("abcd")).toBe("***");
  });

  it("shows first 2 + *** + last 2 for longer secrets", () => {
    expect(redactSecret("abcde")).toBe("ab***de");
    expect(redactSecret("sk-1234567890ef")).toBe("sk***ef");
  });

  it("does not reveal the secret length beyond short-vs-long", () => {
    // Two different long secrets of different lengths both collapse to a
    // fixed-width masked form — the mask itself can't be used to infer length.
    expect(redactSecret("abcdef")).toBe("ab***ef");
    expect(redactSecret("abcdefghijklmnop")).toBe("ab***op");
  });

  it("never returns the original value for non-trivial secrets", () => {
    const secret = "super-secret-token-value";
    const out = redactSecret(secret);
    expect(out).not.toBe(secret);
    expect(out).not.toContain("secret-token");
  });
});
