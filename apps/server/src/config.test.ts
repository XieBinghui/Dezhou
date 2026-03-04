import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("config", () => {
  it("loads development defaults", () => {
    const cfg = loadConfig({ NODE_ENV: "development" });
    expect(cfg.port).toBe(3000);
    expect(cfg.redisUrl).toContain("redis://");
    expect(cfg.postgresUrl).toContain("postgres://");
    expect(cfg.webOrigins.length).toBeGreaterThanOrEqual(1);
  });

  it("fails when production required env is missing", () => {
    expect(() => loadConfig({ NODE_ENV: "production", REDIS_URL: "redis://x", POSTGRES_URL: "postgres://y" })).toThrow(
      "SESSION_SECRET"
    );
  });

  it("fails for invalid rate limit settings", () => {
    expect(() => loadConfig({ NODE_ENV: "development", RATE_LIMIT_MAX: "0" })).toThrow("RATE_LIMIT_MAX");
  });
});
