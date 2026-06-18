import { describe, it, expect } from "vitest";
import { DeliveryDedup } from "../src/integrations/n8n.js";

// I-071: unit tests for the in-memory replay-dedup LRU, driving the injectable
// `now` parameter so TTL behaviour is deterministic (no real clock / sleeps).
describe("I-071 DeliveryDedup (LRU + TTL)", () => {
  it("first occurrence is fresh, immediate repeat is a replay", () => {
    const d = new DeliveryDedup();
    expect(d.checkAndAdd("a")).toBe(false);
    expect(d.checkAndAdd("a")).toBe(true);
    expect(d.checkAndAdd("b")).toBe(false);
  });

  it("an entry past its TTL is treated as unseen again", () => {
    const ttl = 1000;
    const d = new DeliveryDedup(100, ttl);
    expect(d.checkAndAdd("x", 0)).toBe(false);
    // Within TTL ⇒ still a replay.
    expect(d.checkAndAdd("x", ttl - 1)).toBe(true);
    // At/after TTL ⇒ expired, counts as fresh again.
    expect(d.checkAndAdd("x", ttl)).toBe(false);
  });

  it("evicts the oldest entry once the size cap is exceeded", () => {
    const d = new DeliveryDedup(3, 60_000);
    d.checkAndAdd("a", 1);
    d.checkAndAdd("b", 2);
    d.checkAndAdd("c", 3);
    expect(d.size).toBe(3);
    // 4th insert overflows ⇒ oldest ("a") evicted.
    d.checkAndAdd("d", 4);
    expect(d.size).toBe(3);
    // "a" was evicted, so it now looks fresh; "d" is still a replay.
    expect(d.checkAndAdd("a", 5)).toBe(false);
    expect(d.checkAndAdd("d", 6)).toBe(true);
  });

  it("expired entries are swept on insert, bounding memory over time", () => {
    const ttl = 1000;
    const d = new DeliveryDedup(1000, ttl);
    d.checkAndAdd("old1", 0);
    d.checkAndAdd("old2", 10);
    expect(d.size).toBe(2);
    // Insert well past the TTL of old1/old2 ⇒ they get swept.
    d.checkAndAdd("new", 5000);
    expect(d.size).toBe(1);
  });

  it("clear() drops all tracked ids", () => {
    const d = new DeliveryDedup();
    d.checkAndAdd("a");
    d.checkAndAdd("b");
    expect(d.size).toBe(2);
    d.clear();
    expect(d.size).toBe(0);
    expect(d.checkAndAdd("a")).toBe(false);
  });
});
