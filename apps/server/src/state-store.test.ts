import { describe, expect, it } from "vitest";
import { RedisStateStore, type EngineSnapshot } from "./state-store.js";

class MemoryRedis {
  private readonly kv = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
}

function mockSnapshot(): EngineSnapshot {
  return {
    version: 1,
    tableId: "main-table",
    maxSeats: 10,
    sb: 1,
    bb: 2,
    buyIn: 200,
    actionSeconds: 20,
    hostPlayerId: "p1",
    buttonPos: 3,
    waiting: ["p3"],
    seats: ["p1", "p2", null, null, null, null, null, null, null, null],
    players: [
      {
        playerId: "p1",
        nickname: "A",
        token: "t1",
        socketId: null,
        isConnected: false,
        disconnectedAt: null,
        seatIndex: 0,
        stack: 180,
        pendingRebuy: false,
        ready: true,
        lastAction: null
      },
      {
        playerId: "p2",
        nickname: "B",
        token: "t2",
        socketId: null,
        isConnected: false,
        disconnectedAt: null,
        seatIndex: 1,
        stack: 160,
        pendingRebuy: false,
        ready: true,
        lastAction: null
      }
    ],
    hand: {
      handId: "h1",
      deck: [],
      board: [],
      street: "preflop",
      toActSeat: 0,
      currentBet: 2,
      minRaiseTo: 4,
      lastFullRaiseSize: 2,
      actionDeadlineTs: 1000,
      startedAt: 1,
      showdownAt: null,
      streetContrib: [
        ["p1", 1],
        ["p2", 2]
      ],
      totalContrib: [
        ["p1", 1],
        ["p2", 2]
      ],
      hasActed: [
        ["p1", false],
        ["p2", true]
      ],
      folded: [],
      allIn: [],
      holeCards: [],
      actionLog: [],
      pots: [],
      positionLabels: []
    },
    savedAt: 12345
  };
}

describe("redis state store", () => {
  it("saves and loads snapshot consistently", async () => {
    const redis = new MemoryRedis();
    const store = new RedisStateStore(redis, "table:main");
    const snapshot = mockSnapshot();

    await store.save(snapshot);
    const loaded = await store.load();

    expect(loaded).toEqual(snapshot);
  });
});
