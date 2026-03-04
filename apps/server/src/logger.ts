export type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.write("error", message, extra);
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (rank[level] < rank[this.level]) {
      return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...extra
    });
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(line);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(line);
  }
}
