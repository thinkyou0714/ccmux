import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import {
  homeDir,
  ccmuxDir,
  configFile,
  sessionsFile,
  handoffsDir,
  logsDir,
  locksDir,
} from "../src/core/paths.js";

// Snapshot only the env vars these helpers read, and restore them after each
// case so ordering can't leak state between tests.
const ORIG = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CCMUX_DIR: process.env.CCMUX_DIR,
};

function restore(key: keyof typeof ORIG): void {
  if (ORIG[key] === undefined) delete process.env[key];
  else process.env[key] = ORIG[key];
}

afterEach(() => {
  restore("HOME");
  restore("USERPROFILE");
  restore("CCMUX_DIR");
});

describe("homeDir", () => {
  it("prefers HOME", () => {
    process.env.HOME = "/home/test";
    process.env.USERPROFILE = "C:/Users/test";
    expect(homeDir()).toBe("/home/test");
  });

  it("falls back to USERPROFILE when HOME is unset (Windows)", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "C:/Users/test";
    expect(homeDir()).toBe("C:/Users/test");
  });

  it("falls back to empty string when neither is set", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(homeDir()).toBe("");
  });
});

describe("ccmuxDir", () => {
  it("uses CCMUX_DIR override above HOME", () => {
    process.env.CCMUX_DIR = "/explicit/dir";
    process.env.HOME = "/home/test";
    expect(ccmuxDir()).toBe("/explicit/dir");
  });

  it("defaults to ${HOME}/.ccmux", () => {
    delete process.env.CCMUX_DIR;
    process.env.HOME = "/home/test";
    expect(ccmuxDir()).toBe("/home/test/.ccmux");
  });

  it("honours the Windows USERPROFILE fallback", () => {
    delete process.env.CCMUX_DIR;
    delete process.env.HOME;
    process.env.USERPROFILE = "C:/Users/test";
    expect(ccmuxDir()).toBe("C:/Users/test/.ccmux");
  });
});

describe("derived paths sit under ccmuxDir", () => {
  it("resolve config/sessions/handoffs/logs/locks relative to the state dir", () => {
    process.env.CCMUX_DIR = "/state";
    expect(configFile()).toBe(path.join("/state", "config.json"));
    expect(sessionsFile()).toBe(path.join("/state", "sessions.json"));
    expect(handoffsDir()).toBe(path.join("/state", "handoffs"));
    expect(logsDir()).toBe(path.join("/state", "logs"));
    expect(locksDir()).toBe(path.join("/state", "locks"));
  });
});

describe("lazy resolution", () => {
  it("re-reads CCMUX_DIR on every call (never captured at import)", () => {
    process.env.CCMUX_DIR = "/first";
    expect(ccmuxDir()).toBe("/first");
    process.env.CCMUX_DIR = "/second";
    expect(ccmuxDir()).toBe("/second");
    expect(sessionsFile()).toBe(path.join("/second", "sessions.json"));
  });
});
