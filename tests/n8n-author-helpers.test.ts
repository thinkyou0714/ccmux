import { describe, it, expect } from "vitest";
import { extractIssueAuthor, isAuthorAllowed } from "../src/integrations/n8n.js";

// I-095: pure-helper unit tests for the author extraction + allowlist decision.
describe("extractIssueAuthor (I-095)", () => {
  it("prefers issue.user.login", () => {
    expect(
      extractIssueAuthor({ issue: { user: { login: "alice" } }, sender: { login: "bob" } }),
    ).toBe("alice");
  });

  it("falls back to sender.login when issue author is missing", () => {
    expect(extractIssueAuthor({ issue: { number: 1 }, sender: { login: "bob" } })).toBe("bob");
    expect(extractIssueAuthor({ sender: { login: "bob" } })).toBe("bob");
  });

  it("returns undefined when neither is a non-empty string", () => {
    expect(extractIssueAuthor({})).toBeUndefined();
    expect(extractIssueAuthor({ issue: { user: { login: "" } } })).toBeUndefined();
    expect(extractIssueAuthor({ issue: { user: { login: 123 } } })).toBeUndefined();
    expect(extractIssueAuthor({ sender: { login: null } })).toBeUndefined();
  });
});

describe("isAuthorAllowed (I-095)", () => {
  it("allows everyone when the list is undefined (unrestricted)", () => {
    expect(isAuthorAllowed("anyone", undefined)).toBe(true);
    expect(isAuthorAllowed(undefined, undefined)).toBe(true);
  });

  it("gates on membership when a list is provided", () => {
    expect(isAuthorAllowed("alice", ["alice", "bob"])).toBe(true);
    expect(isAuthorAllowed("mallory", ["alice", "bob"])).toBe(false);
  });

  it("rejects a missing author when a list is provided (even empty list)", () => {
    expect(isAuthorAllowed(undefined, ["alice"])).toBe(false);
    expect(isAuthorAllowed(undefined, [])).toBe(false);
    expect(isAuthorAllowed("alice", [])).toBe(false);
  });
});
