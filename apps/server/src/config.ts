export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  webOrigins: string[];
  redisUrl: string;
  postgresUrl: string;
  sessionSecret: string;
  logLevel: "debug" | "info" | "warn" | "error";
  rateLimitWindowMs: number;
  rateLimitMax: number;
  socketRateLimitWindowMs: number;
  socketRateLimitMax: number;
  persistIntervalMs: number;
}

function parseNumber(name: string, raw: string | undefined, defaultValue: number): number {
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数`);
  }
  return value;
}

function parseOrigins(raw: string | undefined): string[] {
  const input = raw ?? "http://localhost:5173,http://localhost:8080";
  const origins = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error("WEB_ORIGIN 不能为空");
  }
  return origins;
}

function must(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new Error(`缺少必填环境变量 ${name}`);
  }
  return value.trim();
}

export function loadConfig(env = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? "development") as AppConfig["env"];
  const isProd = nodeEnv === "production";

  const redisUrl = isProd ? must(env.REDIS_URL, "REDIS_URL") : (env.REDIS_URL ?? "redis://localhost:6379");
  const postgresUrl = isProd
    ? must(env.POSTGRES_URL, "POSTGRES_URL")
    : (env.POSTGRES_URL ?? "postgres://dezhou:dezhou@localhost:5432/dezhou");
  const sessionSecret = isProd ? must(env.SESSION_SECRET, "SESSION_SECRET") : (env.SESSION_SECRET ?? "dev-session-secret");
  const logLevel = (env.LOG_LEVEL ?? "info") as AppConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("LOG_LEVEL 必须是 debug/info/warn/error");
  }

  return {
    env: nodeEnv,
    port: parseNumber("PORT", env.PORT, 3000),
    webOrigins: parseOrigins(env.WEB_ORIGIN),
    redisUrl,
    postgresUrl,
    sessionSecret,
    logLevel,
    rateLimitWindowMs: parseNumber("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, 10_000),
    rateLimitMax: parseNumber("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 120),
    socketRateLimitWindowMs: parseNumber("RATE_LIMIT_SOCKET_WINDOW_MS", env.RATE_LIMIT_SOCKET_WINDOW_MS, 10_000),
    socketRateLimitMax: parseNumber("RATE_LIMIT_SOCKET_MAX", env.RATE_LIMIT_SOCKET_MAX, 80),
    persistIntervalMs: parseNumber("PERSIST_INTERVAL_MS", env.PERSIST_INTERVAL_MS, 1_000)
  };
}
