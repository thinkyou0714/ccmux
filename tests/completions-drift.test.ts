import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Root-cause guard for IDEA-084: the shell completions and README drifted from
// the actual CLI (reflect/dashboard were registered in src/index.ts but missing
// from completions/*). This test fails if any registered command or alias is
// absent from either completion file, so the drift cannot silently reappear.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function registeredNames(): string[] {
  const src = read("src/index.ts");
  const names = new Set<string>();
  for (const m of src.matchAll(/\.command\(\s*["'`]([a-z][a-z0-9-]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of src.matchAll(/\.alias\(\s*["'`]([a-z][a-z0-9-]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

function wordsFrom(text: string, marker: RegExp): string[] {
  const m = text.match(marker);
  if (!m || m[1] === undefined) return [];
  return m[1].trim().split(/\s+/);
}

describe("shell completions stay in sync with the CLI", () => {
  const registered = registeredNames();

  it("registers a non-trivial command set", () => {
    expect(registered.length).toBeGreaterThan(5);
    expect(registered).toContain("reflect");
    expect(registered).toContain("dashboard");
  });

  it("completions/ccmux.bash covers every registered command + alias", () => {
    const words = wordsFrom(read("completions/ccmux.bash"), /commands="([^"]*)"/);
    const missing = registered.filter((c) => !words.includes(c));
    expect(missing, `missing from completions/ccmux.bash: ${missing.join(", ")}`).toEqual([]);
  });

  it("completions/_ccmux covers every registered command + alias", () => {
    const words = wordsFrom(read("completions/_ccmux"), /compadd ([a-z][^\n]+)/);
    const missing = registered.filter((c) => !words.includes(c));
    expect(missing, `missing from completions/_ccmux: ${missing.join(", ")}`).toEqual([]);
  });
});
