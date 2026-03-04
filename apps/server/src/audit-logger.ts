import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AuditLogger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  write(event: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
    appendFileSync(this.filePath, line, "utf8");
  }
}
