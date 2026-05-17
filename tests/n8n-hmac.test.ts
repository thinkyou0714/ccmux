import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyGitHubSignature } from "../src/integrations/n8n.js";

function sign(body: Buffer, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("BL-1: verifyGitHubSignature", () => {
  const secret = "shh-its-a-secret";
  const body = Buffer.from(JSON.stringify({ action: "opened", issue: { number: 1 } }));

  it("accepts a valid signature", () => {
    expect(verifyGitHubSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature signed with the wrong secret", () => {
    expect(verifyGitHubSignature(body, sign(body, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects a signature over a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ action: "opened", issue: { number: 999 } }));
    expect(verifyGitHubSignature(tampered, sign(body, secret), secret)).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects empty secret", () => {
    expect(verifyGitHubSignature(body, sign(body, secret), "")).toBe(false);
  });

  it("rejects malformed signature (wrong length, no throw)", () => {
    // crypto.timingSafeEqual throws on length mismatch; verify our guard catches it.
    expect(() => verifyGitHubSignature(body, "sha256=deadbeef", secret)).not.toThrow();
    expect(verifyGitHubSignature(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects signature without sha256= prefix", () => {
    const justHex = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGitHubSignature(body, justHex, secret)).toBe(false);
  });

  it("is order-independent on body bytes", () => {
    // Re-serialized JSON with same fields in a different order will NOT match —
    // because GitHub signs the bytes as sent. Document this expectation.
    const reordered = Buffer.from(JSON.stringify({ issue: { number: 1 }, action: "opened" }));
    expect(verifyGitHubSignature(reordered, sign(body, secret), secret)).toBe(false);
    expect(verifyGitHubSignature(reordered, sign(reordered, secret), secret)).toBe(true);
  });
});
