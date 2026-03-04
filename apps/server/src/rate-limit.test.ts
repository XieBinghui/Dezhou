import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit.js";

describe("rate limiter", () => {
  it("blocks after max in one window", () => {
    const limiter = new SlidingWindowLimiter(10_000, 2);
    expect(limiter.take("k", 100)).toBe(true);
    expect(limiter.take("k", 101)).toBe(true);
    expect(limiter.take("k", 102)).toBe(false);
  });

  it("resets after window elapsed", () => {
    const limiter = new SlidingWindowLimiter(100, 1);
    expect(limiter.take("k", 100)).toBe(true);
    expect(limiter.take("k", 150)).toBe(false);
    expect(limiter.take("k", 201)).toBe(true);
  });
});
