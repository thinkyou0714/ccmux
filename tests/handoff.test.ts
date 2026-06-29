import { describe, expect, it } from "vitest";
import { buildHandoffMarkdown } from "../src/core/handoff.js";

describe("handoff markdown rendering", () => {
  it("renders shared sections and cost consistently", () => {
    const md = buildHandoffMarkdown({
      sessionName: "demo",
      branch: "ccmux/demo",
      diff: "M src/index.ts",
      costUSD: 12.345,
      currency: "JPY",
      exchangeRate: 155,
      gitLog: "abc123 update",
      todos: ["ship it"],
      claudeMdContent: "notes",
    }, { date: new Date("2026-06-29T00:00:00.000Z") });

    expect(md).toContain("# ccmux handoff: demo");
    expect(md).toContain("- date: 2026-06-29T00:00:00.000Z");
    expect(md).toContain("- branch: ccmux/demo");
    expect(md).toContain("- cost: ¥1,914");
    expect(md).toContain("M src/index.ts");
    expect(md).toContain("abc123 update");
    expect(md).toContain("- [ ] ship it");
    expect(md).toContain("notes");
  });

  it("can fence diff output for Obsidian handoffs", () => {
    const md = buildHandoffMarkdown({
      sessionName: "demo",
      branch: "ccmux/demo",
      diff: "diff --git a/x b/x",
    }, { fenceDiff: true, date: new Date("2026-06-29T00:00:00.000Z") });

    expect(md).toContain("## diff summary\n```\ndiff --git a/x b/x\n```");
  });
});
