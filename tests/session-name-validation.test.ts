import { describe, it, expect } from "vitest";
import { validateSessionName, assertSessionName } from "../src/core/session-name.js";

describe("H-01: validateSessionName", () => {
  describe("accepts safe names", () => {
    for (const name of [
      "abc",
      "abc-123",
      "abc_def",
      "Foo-Bar_42",
      "a", // single char
      "x".padEnd(63, "y"), // exactly max length
      "auto-1234",
      "issue-42",
      "feat-h01-validate",
    ]) {
      it(`accepts ${JSON.stringify(name)}`, () => {
        expect(validateSessionName(name).ok).toBe(true);
      });
    }
  });

  describe("rejects unsafe names", () => {
    const cases: Array<{ name: unknown; tag: string }> = [
      { name: "", tag: "empty" },
      { name: "x".padEnd(64, "y"), tag: "too long" },
      { name: "-leading-dash", tag: "leading dash" },
      { name: "../../etc/passwd", tag: "path traversal" },
      { name: "..", tag: ".. component" },
      { name: "foo..bar", tag: "embedded ..  " },
      { name: "foo/bar", tag: "slash" },
      { name: "foo bar", tag: "space" },
      { name: "foo;rm -rf /", tag: "shell metachars" },
      { name: "foo`whoami`", tag: "backticks" },
      { name: "foo$(id)", tag: "command substitution" },
      { name: "foo'OR'1'='1", tag: "quotes" },
      { name: "foo.lock", tag: "git .lock suffix" },
      { name: "branch@{1}", tag: "reflog syntax" },
      { name: "foo\nbar", tag: "newline" },
      { name: "foo\x00bar", tag: "NUL byte" },
      { name: "日本語", tag: "non-ASCII" },
      { name: ".hidden", tag: "leading dot" },
      { name: null, tag: "null" },
      { name: 42, tag: "number" },
      { name: undefined, tag: "undefined" },
    ];
    for (const { name, tag } of cases) {
      it(`rejects ${tag}: ${JSON.stringify(name)}`, () => {
        const r = validateSessionName(name);
        expect(r.ok).toBe(false);
      });
    }
  });

  it("assertSessionName throws on invalid input", () => {
    expect(() => assertSessionName("../evil")).toThrow(/Invalid ccmux session name/);
    expect(() => assertSessionName("ok-name")).not.toThrow();
  });
});
