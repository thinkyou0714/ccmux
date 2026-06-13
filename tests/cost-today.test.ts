import { describe, it, expect, afterEach } from "vitest";
import { localToday } from "../src/core/cost.js";

const orig = process.env.CCMUX_TIMEZONE;

afterEach(() => {
  if (orig === undefined) delete process.env.CCMUX_TIMEZONE;
  else process.env.CCMUX_TIMEZONE = orig;
});

describe("localToday (G050 — TZ-aware daily bucket)", () => {
  it("uses the local zone, not UTC, for an evening Tokyo instant", () => {
    // 2026-06-13 22:30 JST == 2026-06-13 13:30 UTC. Same calendar day in both
    // here, so pick an instant where UTC and JST differ: 2026-06-13 23:30 JST
    // == 2026-06-13 14:30 UTC (still same day) — instead use a post-midnight-UTC
    // evening: 2026-06-13 09:00 JST == 2026-06-13 00:00 UTC. Use the classic
    // failing case: late Tokyo evening that UTC still calls the *previous* day.
    // 2026-06-14 06:00 JST == 2026-06-13 21:00 UTC.
    const instant = new Date("2026-06-13T21:00:00Z");
    process.env.CCMUX_TIMEZONE = "Asia/Tokyo";
    expect(localToday(instant)).toBe("2026-06-14");
  });

  it("honours an explicit UTC override", () => {
    const instant = new Date("2026-06-13T21:00:00Z");
    process.env.CCMUX_TIMEZONE = "UTC";
    expect(localToday(instant)).toBe("2026-06-13");
  });

  it("formats as YYYY-MM-DD", () => {
    expect(localToday(new Date("2026-01-05T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
