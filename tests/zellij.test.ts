import { describe, it, expect, afterEach } from "vitest";
import { getMuxInfo } from "../src/core/zellij.js";

// getMuxInfo()/detectMultiplexer() are pure env readers — the routing decision
// every command makes (zellij tab vs tmux window vs stdout). Snapshot & restore
// only the two vars they read.
const ORIG = { ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME, TMUX: process.env.TMUX };

function restore(key: keyof typeof ORIG): void {
  if (ORIG[key] === undefined) delete process.env[key];
  else process.env[key] = ORIG[key];
}

afterEach(() => {
  restore("ZELLIJ_SESSION_NAME");
  restore("TMUX");
});

describe("getMuxInfo", () => {
  it("detects zellij and reports the session name", () => {
    process.env.ZELLIJ_SESSION_NAME = "lab";
    delete process.env.TMUX;
    expect(getMuxInfo()).toEqual({ type: "zellij", session: "lab" });
  });

  it("prefers zellij over tmux when both are set", () => {
    process.env.ZELLIJ_SESSION_NAME = "lab";
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    expect(getMuxInfo().type).toBe("zellij");
  });

  it("detects tmux and reports the socket path (first comma field)", () => {
    delete process.env.ZELLIJ_SESSION_NAME;
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    expect(getMuxInfo()).toEqual({ type: "tmux", session: "/tmp/tmux-1000/default" });
  });

  it("reports none when neither multiplexer is present", () => {
    delete process.env.ZELLIJ_SESSION_NAME;
    delete process.env.TMUX;
    expect(getMuxInfo()).toEqual({ type: "none", session: undefined });
  });
});
