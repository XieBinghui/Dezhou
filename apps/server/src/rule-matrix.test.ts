import { describe, expect, it } from "vitest";
import type { Card, HandResultDTO, TableStateDTO } from "@dezhou/shared";
import type { TableEngine } from "./table-engine.js";
import { TableEngine as Engine } from "./table-engine.js";

type EngineInternals = {
  hand: {
    board: Card[];
    folded: Set<string>;
    totalContrib: Map<string, number>;
    holeCards: Map<string, [Card, Card]>;
  };
  players: Map<string, { stack: number }>;
  finishHand: () => void;
};

function setup(count: number): {
  engine: TableEngine;
  playerIds: string[];
  states: Map<string, TableStateDTO>;
  handResults: HandResultDTO[];
} {
  const states = new Map<string, TableStateDTO>();
  const handResults: HandResultDTO[] = [];

  const engine = new Engine(
    {
      onTableState: (playerId, state) => {
        states.set(playerId, state);
      },
      onStateChanged: (playerId, partial) => {
        const prev = states.get(playerId);
        if (!prev) {
          return;
        }
        states.set(playerId, { ...prev, hand: partial.hand, seats: partial.seats });
      },
      onActionEvent: () => {},
      onHandResult: (_playerId, result) => {
        if (!handResults.find((r) => r.handId === result.handId)) {
          handResults.push(result);
        }
      },
      onNotice: () => {},
      onAudit: () => {}
    },
    { actionSeconds: 2 }
  );

  const playerIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const join = engine.join({ nickname: `R${i + 1}`, socketId: `r${i + 1}` });
    if (!join.ok || !join.playerId) {
      throw new Error("join failed");
    }
    playerIds.push(join.playerId);
    expect(engine.sit(join.playerId, i).ok).toBe(true);
  }

  for (const id of playerIds) {
    expect(engine.setReady(id, true).ok).toBe(true);
  }
  expect(engine.startHandByHost(playerIds[0]).ok).toBe(true);

  return { engine, playerIds, states, handResults };
}

function getState(states: Map<string, TableStateDTO>, playerId: string): TableStateDTO {
  const state = states.get(playerId);
  if (!state) {
    throw new Error("state missing");
  }
  return state;
}

function nextOccupiedSeat(state: TableStateDTO, start: number): number {
  for (let i = 1; i <= state.maxSeats; i += 1) {
    const idx = (start + i) % state.maxSeats;
    if (state.seats[idx].playerId) {
      return idx;
    }
  }
  return start;
}

describe("rule matrix expansion", () => {
  describe("minimum raise boundary table", () => {
    it("preflop raise boundary: min-1 rejected, min accepted", () => {
      const { engine, playerIds, states } = setup(2);
      const state = getState(states, playerIds[0]);
      const actorSeat = state.hand.toActSeat!;
      const actorId = state.seats[actorSeat].playerId!;

      const invalid = engine.applyAction(actorId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: state.hand.minRaiseTo - 1
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.reason).toContain("最小加注");

      const valid = engine.applyAction(actorId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: state.hand.minRaiseTo
      });
      expect(valid.ok).toBe(true);
    });

    it("postflop bet boundary: min-1 rejected, min accepted", () => {
      const { engine, playerIds, states } = setup(2);
      let state = getState(states, playerIds[0]);

      const preflopActorId = state.seats[state.hand.toActSeat!].playerId!;
      expect(engine.applyAction(preflopActorId, { handId: state.hand.handId!, action: "call" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      const secondActorId = state.seats[state.hand.toActSeat!].playerId!;
      expect(engine.applyAction(secondActorId, { handId: state.hand.handId!, action: "check" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.street).toBe("flop");
      expect(state.hand.currentBet).toBe(0);

      const flopActorId = state.seats[state.hand.toActSeat!].playerId!;
      const invalidBet = engine.applyAction(flopActorId, {
        handId: state.hand.handId!,
        action: "bet",
        amount: state.hand.bigBlind - 1
      });
      expect(invalidBet.ok).toBe(false);
      expect(invalidBet.reason).toContain("最小下注");

      const validBet = engine.applyAction(flopActorId, {
        handId: state.hand.handId!,
        action: "bet",
        amount: state.hand.bigBlind
      });
      expect(validBet.ok).toBe(true);
    });

    it("short stack can break min-raise only via all-in", () => {
      const { engine, playerIds, states } = setup(3);
      let state = getState(states, playerIds[0]);
      const aSeat = state.hand.toActSeat!;
      const bSeat = nextOccupiedSeat(state, aSeat);
      const aId = state.seats[aSeat].playerId!;
      const bId = state.seats[bSeat].playerId!;

      const players = (engine as unknown as { players: Map<string, { stack: number }> }).players;
      const bCommitted = state.seats[bSeat].committed;
      players.get(bId)!.stack = 9 - bCommitted;

      expect(engine.applyAction(aId, { handId: state.hand.handId!, action: "raise", amount: 6 }).ok).toBe(true);
      state = getState(states, playerIds[0]);
      expect(state.hand.toActSeat).toBe(bSeat);

      const invalidRaise = engine.applyAction(bId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: 8
      });
      expect(invalidRaise.ok).toBe(false);
      expect(invalidRaise.reason).toContain("最小加注");

      const validAllIn = engine.applyAction(bId, {
        handId: state.hand.handId!,
        action: "allin"
      });
      expect(validAllIn.ok).toBe(true);
    });
  });

  describe("all-in reopen full paths", () => {
    it("does not reopen raise after short all-in for player who has acted", () => {
      const { engine, playerIds, states } = setup(3);
      let state = getState(states, playerIds[0]);

      const aSeat = state.hand.toActSeat!;
      const bSeat = nextOccupiedSeat(state, aSeat);
      const cSeat = nextOccupiedSeat(state, bSeat);
      const aId = state.seats[aSeat].playerId!;
      const bId = state.seats[bSeat].playerId!;
      const cId = state.seats[cSeat].playerId!;

      const players = (engine as unknown as { players: Map<string, { stack: number }> }).players;
      const bCommitted = state.seats[bSeat].committed;
      players.get(bId)!.stack = 8 - bCommitted;

      expect(engine.applyAction(aId, { handId: state.hand.handId!, action: "raise", amount: 6 }).ok).toBe(true);
      state = getState(states, playerIds[0]);
      expect(engine.applyAction(bId, { handId: state.hand.handId!, action: "allin" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.toActSeat).toBe(cSeat);
      expect(engine.applyAction(cId, { handId: state.hand.handId!, action: "call" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.toActSeat).toBe(aSeat);
      const illegalReopen = engine.applyAction(aId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: state.hand.minRaiseTo
      });
      expect(illegalReopen.ok).toBe(false);
      expect(illegalReopen.reason).toContain("未重新开启加注");
    });

    it("keeps min re-raise size after short all-in for player who has not acted", () => {
      const { engine, playerIds, states } = setup(3);
      let state = getState(states, playerIds[0]);

      const aSeat = state.hand.toActSeat!;
      const bSeat = nextOccupiedSeat(state, aSeat);
      const cSeat = nextOccupiedSeat(state, bSeat);
      const aId = state.seats[aSeat].playerId!;
      const bId = state.seats[bSeat].playerId!;
      const cId = state.seats[cSeat].playerId!;

      const players = (engine as unknown as { players: Map<string, { stack: number }> }).players;
      const bCommitted = state.seats[bSeat].committed;
      players.get(bId)!.stack = 8 - bCommitted;

      expect(engine.applyAction(aId, { handId: state.hand.handId!, action: "raise", amount: 6 }).ok).toBe(true);
      state = getState(states, playerIds[0]);
      expect(engine.applyAction(bId, { handId: state.hand.handId!, action: "allin" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.toActSeat).toBe(cSeat);
      expect(state.hand.currentBet).toBe(8);
      expect(state.hand.minRaiseTo).toBe(12);

      const invalidRaise = engine.applyAction(cId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: 11
      });
      expect(invalidRaise.ok).toBe(false);
      expect(invalidRaise.reason).toContain("最小加注到 12");

      const validRaise = engine.applyAction(cId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: 12
      });
      expect(validRaise.ok).toBe(true);
    });

    it("reopens raise after full all-in raise", () => {
      const { engine, playerIds, states } = setup(3);
      let state = getState(states, playerIds[0]);

      const aSeat = state.hand.toActSeat!;
      const bSeat = nextOccupiedSeat(state, aSeat);
      const cSeat = nextOccupiedSeat(state, bSeat);
      const aId = state.seats[aSeat].playerId!;
      const bId = state.seats[bSeat].playerId!;
      const cId = state.seats[cSeat].playerId!;

      const players = (engine as unknown as { players: Map<string, { stack: number }> }).players;
      const bCommitted = state.seats[bSeat].committed;
      players.get(bId)!.stack = 10 - bCommitted;

      expect(engine.applyAction(aId, { handId: state.hand.handId!, action: "raise", amount: 6 }).ok).toBe(true);
      state = getState(states, playerIds[0]);
      expect(engine.applyAction(bId, { handId: state.hand.handId!, action: "allin" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.currentBet).toBe(10);
      expect(state.hand.minRaiseTo).toBe(14);
      expect(state.hand.toActSeat).toBe(cSeat);
      expect(engine.applyAction(cId, { handId: state.hand.handId!, action: "call" }).ok).toBe(true);

      state = getState(states, playerIds[0]);
      expect(state.hand.toActSeat).toBe(aSeat);
      const reopenRaise = engine.applyAction(aId, {
        handId: state.hand.handId!,
        action: "raise",
        amount: 14
      });
      expect(reopenRaise.ok).toBe(true);
    });
  });

  describe("complex tied side-pot distribution", () => {
    it("splits tied side pot while main pot has single winner", () => {
      const { engine, playerIds, handResults } = setup(4);
      const [p1, p2, p3, p4] = playerIds;
      const internals = engine as unknown as EngineInternals;

      internals.hand.board = [
        { rank: "Q", suit: "s" },
        { rank: "Q", suit: "h" },
        { rank: "7", suit: "d" },
        { rank: "7", suit: "c" },
        { rank: "2", suit: "h" }
      ];
      internals.hand.folded = new Set<string>();
      internals.hand.totalContrib = new Map([
        [p1, 100],
        [p2, 250],
        [p3, 250],
        [p4, 250]
      ]);
      internals.hand.holeCards = new Map([
        [p1, [{ rank: "2", suit: "c" }, { rank: "2", suit: "d" }]],
        [p2, [{ rank: "A", suit: "s" }, { rank: "3", suit: "c" }]],
        [p3, [{ rank: "A", suit: "d" }, { rank: "4", suit: "s" }]],
        [p4, [{ rank: "K", suit: "c" }, { rank: "J", suit: "d" }]]
      ]);

      internals.players.get(p1)!.stack = 0;
      internals.players.get(p2)!.stack = 0;
      internals.players.get(p3)!.stack = 0;
      internals.players.get(p4)!.stack = 0;

      internals.finishHand();

      const result = handResults.at(-1);
      expect(result).toBeTruthy();
      expect(result!.showdownPlayers.length).toBe(4);

      const winMap = new Map(result!.winners.map((w) => [w.playerId, w.amount]));
      expect(winMap.get(p1)).toBe(400);
      expect(winMap.get(p2)).toBe(225);
      expect(winMap.get(p3)).toBe(225);
      expect(winMap.get(p4)).toBeUndefined();

      expect(internals.players.get(p1)!.stack).toBe(400);
      expect(internals.players.get(p2)!.stack).toBe(225);
      expect(internals.players.get(p3)!.stack).toBe(225);
      expect(internals.players.get(p4)!.stack).toBe(0);
    });

    it("splits odd chips deterministically in tied side pot", () => {
      const { engine, playerIds, handResults } = setup(4);
      const [p1, p2, p3, p4] = playerIds;
      const internals = engine as unknown as EngineInternals;

      internals.hand.board = [
        { rank: "Q", suit: "s" },
        { rank: "Q", suit: "h" },
        { rank: "7", suit: "d" },
        { rank: "7", suit: "c" },
        { rank: "2", suit: "h" }
      ];
      internals.hand.folded = new Set<string>();
      internals.hand.totalContrib = new Map([
        [p1, 100],
        [p2, 251],
        [p3, 251],
        [p4, 251]
      ]);
      internals.hand.holeCards = new Map([
        [p1, [{ rank: "2", suit: "c" }, { rank: "2", suit: "d" }]],
        [p2, [{ rank: "A", suit: "s" }, { rank: "3", suit: "c" }]],
        [p3, [{ rank: "A", suit: "d" }, { rank: "4", suit: "s" }]],
        [p4, [{ rank: "K", suit: "c" }, { rank: "J", suit: "d" }]]
      ]);

      internals.players.get(p1)!.stack = 0;
      internals.players.get(p2)!.stack = 0;
      internals.players.get(p3)!.stack = 0;
      internals.players.get(p4)!.stack = 0;

      internals.finishHand();

      const result = handResults.at(-1);
      expect(result).toBeTruthy();

      const winMap = new Map(result!.winners.map((w) => [w.playerId, w.amount]));
      expect(winMap.get(p1)).toBe(400);
      expect(winMap.get(p2)).toBe(227);
      expect(winMap.get(p3)).toBe(226);
      expect(winMap.get(p4)).toBeUndefined();

      const totalPaid = [...winMap.values()].reduce((sum, v) => sum + v, 0);
      expect(totalPaid).toBe(853);
    });
  });
});
