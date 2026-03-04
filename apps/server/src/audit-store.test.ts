import { describe, expect, it } from "vitest";
import { PgAuditStore, type Queryable } from "./audit-store.js";

class MemoryDb implements Queryable {
  public readonly handSummaries = new Map<string, Record<string, unknown>>();
  public readonly actions: Record<string, unknown>[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const normalized = sql.replace(/\\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("create table") || normalized.startsWith("create index")) {
      return { rows: [] };
    }
    if (normalized.startsWith("insert into action_records")) {
      const row = {
        hand_id: String(params[0]),
        ts: Number(params[1]),
        player_id: String(params[2]),
        nickname: String(params[3]),
        street: String(params[4]),
        action: String(params[5]),
        amount: Number(params[6]),
        is_auto: Boolean(params[7])
      };
      this.actions.push(row);
      return { rows: [] };
    }
    if (normalized.startsWith("insert into hand_summaries")) {
      const handId = String(params[0]);
      const existing = this.handSummaries.get(handId) ?? {};
      const isStart = normalized.includes("(hand_id, started_at)");
      const merged = isStart
        ? {
            ...existing,
            hand_id: handId,
            started_at: params[1] ?? existing.started_at ?? null
          }
        : {
            ...existing,
            hand_id: handId,
            ended_at: params[1] ?? existing.ended_at ?? null,
            board: params[2] ?? existing.board ?? null,
            winners: params[3] ?? existing.winners ?? null,
            pot_total: params[4] ?? existing.pot_total ?? 0
          };
      this.handSummaries.set(handId, merged);
      return { rows: [] };
    }
    if (normalized.startsWith("select * from hand_summaries")) {
      const handId = String(params[0]);
      const row = this.handSummaries.get(handId);
      return { rows: row ? [row] : [] };
    }
    if (normalized.startsWith("select * from action_records")) {
      const handId = String(params[0]);
      return { rows: this.actions.filter((x) => x.hand_id === handId) };
    }
    throw new Error(`unsupported query: ${sql}`);
  }
}

describe("pg audit store", () => {
  it("writes action and hand summary records", async () => {
    const db = new MemoryDb();
    const store = new PgAuditStore(db);
    await store.init();

    await store.write({
      type: "hand_start",
      handId: "h1",
      ts: 100
    });
    await store.write({
      type: "action",
      handId: "h1",
      playerId: "p1",
      nickname: "A",
      street: "preflop",
      action: "call",
      amount: 2,
      isAuto: false,
      ts: 101
    });
    await store.write({
      type: "hand_end",
      handId: "h1",
      ts: 200,
      winners: [{ id: "p1", amount: 20 }]
    });

    const trace = await store.getHandTrace("h1");
    expect(trace.summary?.hand_id).toBe("h1");
    expect(trace.actions).toHaveLength(1);
    expect(trace.actions[0].action).toBe("call");
  });
});
