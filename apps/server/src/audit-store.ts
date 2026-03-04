export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

type AuditActionEvent = {
  type: "action";
  handId: string;
  playerId: string;
  action: string;
  amount: number;
  street: string;
  isAuto?: boolean;
  nickname?: string;
  ts?: number;
};

type AuditHandStartEvent = {
  type: "hand_start";
  handId: string;
  ts?: number;
};

type AuditHandEndEvent = {
  type: "hand_end";
  handId: string;
  winners?: Array<{ id: string; amount: number }>;
  board?: unknown;
  ts?: number;
};

type AuditEvent = AuditActionEvent | AuditHandStartEvent | AuditHandEndEvent | Record<string, unknown>;

export class PgAuditStore {
  constructor(private readonly db: Queryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS hand_summaries (
        hand_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL DEFAULT 'main-table',
        started_at BIGINT,
        ended_at BIGINT,
        board JSONB,
        winners JSONB,
        pot_total BIGINT NOT NULL DEFAULT 0
      );
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS action_records (
        id BIGSERIAL PRIMARY KEY,
        hand_id TEXT NOT NULL,
        ts BIGINT NOT NULL,
        player_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        street TEXT NOT NULL,
        action TEXT NOT NULL,
        amount BIGINT NOT NULL DEFAULT 0,
        is_auto BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);
    await this.db.query("CREATE INDEX IF NOT EXISTS idx_action_records_hand_id ON action_records(hand_id);");
    await this.db.query("CREATE INDEX IF NOT EXISTS idx_action_records_player_id ON action_records(player_id);");
  }

  async write(event: AuditEvent): Promise<void> {
    if (event.type === "action") {
      await this.db.query(
        `
          INSERT INTO action_records(hand_id, ts, player_id, nickname, street, action, amount, is_auto)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          event.handId,
          event.ts ?? Date.now(),
          event.playerId,
          event.nickname ?? "",
          event.street,
          event.action,
          event.amount ?? 0,
          event.isAuto ? true : false
        ]
      );
      return;
    }

    if (event.type === "hand_start") {
      await this.db.query(
        `
          INSERT INTO hand_summaries(hand_id, started_at)
          VALUES ($1,$2)
          ON CONFLICT (hand_id) DO UPDATE SET started_at = EXCLUDED.started_at
        `,
        [event.handId, event.ts ?? Date.now()]
      );
      return;
    }

    if (event.type === "hand_end") {
      const winners: Array<{ id: string; amount: number }> = Array.isArray(event.winners)
        ? event.winners.filter((w): w is { id: string; amount: number } => !!w && typeof w.id === "string" && typeof w.amount === "number")
        : [];
      const potTotal = winners.reduce((sum, w) => sum + (w.amount ?? 0), 0);
      await this.db.query(
        `
          INSERT INTO hand_summaries(hand_id, ended_at, board, winners, pot_total)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (hand_id) DO UPDATE SET
            ended_at = EXCLUDED.ended_at,
            board = COALESCE(EXCLUDED.board, hand_summaries.board),
            winners = EXCLUDED.winners,
            pot_total = EXCLUDED.pot_total
        `,
        [event.handId, event.ts ?? Date.now(), event.board ? JSON.stringify(event.board) : null, JSON.stringify(winners), potTotal]
      );
    }
  }

  async getHandTrace(handId: string): Promise<{ summary: Record<string, unknown> | null; actions: Record<string, unknown>[] }> {
    const [summary, actions] = await Promise.all([
      this.db.query("SELECT * FROM hand_summaries WHERE hand_id = $1 LIMIT 1", [handId]),
      this.db.query("SELECT * FROM action_records WHERE hand_id = $1 ORDER BY ts ASC, id ASC", [handId])
    ]);
    return {
      summary: summary.rows[0] ?? null,
      actions: actions.rows
    };
  }
}
