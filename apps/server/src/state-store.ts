import type { ActionType, Card, SeatLastActionDTO, Street } from "@dezhou/shared";

export interface PlayerSessionSnapshot {
  playerId: string;
  nickname: string;
  token: string;
  socketId: string | null;
  isConnected: boolean;
  disconnectedAt: number | null;
  seatIndex: number | null;
  stack: number;
  pendingRebuy: boolean;
  ready: boolean;
  lastAction: SeatLastActionDTO | null;
}

export interface HandRuntimeSnapshot {
  handId: string;
  deck: Card[];
  board: Card[];
  street: Street;
  toActSeat: number | null;
  currentBet: number;
  minRaiseTo: number;
  lastFullRaiseSize: number;
  actionDeadlineTs: number | null;
  startedAt: number;
  showdownAt: number | null;
  streetContrib: Array<[string, number]>;
  totalContrib: Array<[string, number]>;
  hasActed: Array<[string, boolean]>;
  folded: string[];
  allIn: string[];
  holeCards: Array<[string, [Card, Card]]>;
  actionLog: Array<{
    handId: string;
    timestamp: number;
    playerId: string;
    nickname: string;
    street: Street;
    action: ActionType;
    amount: number;
  }>;
  pots: Array<{ amount: number; eligiblePlayerIds: string[] }>;
  positionLabels: Array<[string, string]>;
}

export interface EngineSnapshot {
  version: 1;
  tableId: string;
  maxSeats: number;
  sb: number;
  bb: number;
  buyIn: number;
  actionSeconds: number;
  hostPlayerId: string | null;
  buttonPos: number;
  waiting: string[];
  seats: Array<string | null>;
  players: PlayerSessionSnapshot[];
  hand: HandRuntimeSnapshot | null;
  savedAt: number;
}

export interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export class RedisStateStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "table:main"
  ) {}

  async save(snapshot: EngineSnapshot): Promise<void> {
    const stateOnly = {
      version: snapshot.version,
      tableId: snapshot.tableId,
      maxSeats: snapshot.maxSeats,
      sb: snapshot.sb,
      bb: snapshot.bb,
      buyIn: snapshot.buyIn,
      actionSeconds: snapshot.actionSeconds,
      hostPlayerId: snapshot.hostPlayerId,
      buttonPos: snapshot.buttonPos,
      waiting: snapshot.waiting,
      seats: snapshot.seats,
      players: snapshot.players,
      savedAt: snapshot.savedAt
    };
    await this.redis.set(`${this.prefix}:state`, JSON.stringify(stateOnly));
    await this.redis.set(`${this.prefix}:hand`, JSON.stringify(snapshot.hand));
    await this.redis.set(`${this.prefix}:timer`, JSON.stringify({ actionDeadlineTs: snapshot.hand?.actionDeadlineTs ?? null }));
  }

  async load(): Promise<EngineSnapshot | null> {
    const [stateRaw, handRaw] = await Promise.all([this.redis.get(`${this.prefix}:state`), this.redis.get(`${this.prefix}:hand`)]);
    if (!stateRaw) {
      return null;
    }
    const state = JSON.parse(stateRaw) as Omit<EngineSnapshot, "hand">;
    const hand = handRaw ? (JSON.parse(handRaw) as HandRuntimeSnapshot | null) : null;
    return {
      ...state,
      version: 1,
      hand
    };
  }
}
