import { describe, it, expect } from "vitest";
import { DEFAULT_JPY_EXCHANGE_RATE } from "../src/core/cost.js";
import { buildDefaultContent } from "../src/integrations/obsidian.js";

describe("BUG-04: handoff cost rendering uses the shared JPY default", () => {
  it("renders JPY cost with the 155 default when exchangeRate is omitted", () => {
    const md = buildDefaultContent({
      sessionName: "s",
      branch: "b",
      diff: "",
      costUSD: 2,
      currency: "JPY",
    });
    // 2 * 155 = 310 — the old 150 literal would have produced ¥300.
    expect(md).toContain("- cost: ¥310");
  });

  it("honours an explicit exchangeRate over the default", () => {
    const md = buildDefaultContent({
      sessionName: "s",
      branch: "b",
      diff: "",
      costUSD: 1,
      currency: "JPY",
      exchangeRate: 200,
    });
    expect(md).toContain("- cost: ¥200");
  });

  it("the default constant is 155 (matches config/schema.ts cost.exchangeRate)", () => {
    expect(DEFAULT_JPY_EXCHANGE_RATE).toBe(155);
  });

  it("renders USD cost without applying an exchange rate", () => {
    const md = buildDefaultContent({
      sessionName: "s",
      branch: "b",
      diff: "",
      costUSD: 1.5,
      currency: "USD",
    });
    expect(md).toContain("- cost: $1.500");
  });
});
