import { describe, it, expect } from "vitest";
import {
  isLoopbackHostname,
  resolveRejectUnauthorized,
} from "../src/integrations/obsidian.js";

// I-096: allowInsecureTLS must only weaken TLS for loopback hosts. For any
// non-loopback https endpoint, certificate verification is enforced even when
// the flag is set (and the flag is reported as ignored so the caller warns).

describe("isLoopbackHostname (I-096)", () => {
  it("treats localhost / ::1 / 127.x as loopback (case-insensitive)", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true); // whole 127.0.0.0/8 block
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("treats public/private non-loopback hosts as non-loopback", () => {
    expect(isLoopbackHostname("obsidian.example.com")).toBe(false);
    expect(isLoopbackHostname("10.0.0.5")).toBe(false);
    expect(isLoopbackHostname("192.168.1.10")).toBe(false);
    expect(isLoopbackHostname("evil.com")).toBe(false);
    // Not actually 127.0.0.0/8 — must not be mistaken for loopback.
    expect(isLoopbackHostname("1271.0.0.1")).toBe(false);
    expect(isLoopbackHostname("127.example.com")).toBe(false);
  });
});

describe("resolveRejectUnauthorized (I-096)", () => {
  it("honours allowInsecureTLS for loopback https (verification OFF)", () => {
    expect(resolveRejectUnauthorized("https:", "127.0.0.1", true)).toEqual({
      rejectUnauthorized: false,
      insecureIgnored: false,
    });
    expect(resolveRejectUnauthorized("https:", "localhost", true)).toEqual({
      rejectUnauthorized: false,
      insecureIgnored: false,
    });
    expect(resolveRejectUnauthorized("https:", "::1", true)).toEqual({
      rejectUnauthorized: false,
      insecureIgnored: false,
    });
  });

  it("IGNORES allowInsecureTLS for non-loopback https (verification FORCED on)", () => {
    expect(
      resolveRejectUnauthorized("https:", "obsidian.example.com", true),
    ).toEqual({ rejectUnauthorized: true, insecureIgnored: true });
    expect(resolveRejectUnauthorized("https:", "192.168.1.10", true)).toEqual({
      rejectUnauthorized: true,
      insecureIgnored: true,
    });
  });

  it("verifies by default (flag unset/false) regardless of host", () => {
    expect(resolveRejectUnauthorized("https:", "127.0.0.1", false)).toEqual({
      rejectUnauthorized: true,
      insecureIgnored: false,
    });
    expect(
      resolveRejectUnauthorized("https:", "obsidian.example.com", undefined),
    ).toEqual({ rejectUnauthorized: true, insecureIgnored: false });
  });

  it("is a no-op for non-https (rejectUnauthorized moot, not ignored)", () => {
    expect(resolveRejectUnauthorized("http:", "obsidian.example.com", true)).toEqual({
      rejectUnauthorized: true,
      insecureIgnored: false,
    });
  });
});
