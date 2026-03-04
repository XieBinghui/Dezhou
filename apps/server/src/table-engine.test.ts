import { describe, expect, it } from "vitest";
import type { ActionRecordDTO, HandResultDTO, TableStateDTO } from "@dezhou/shared";
import { TableEngine } from "./table-engine.js";

type ActionEvent = ActionRecordDTO & { isAuto?: boolean };

function setupPlayers(count: number): { engine: TableEngine; playerIds: string[]; states: Map<string, TableStateDTO> } {
  const states = new Map<string, TableStateDTO>();
  const engine = new TableEngine(
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
      onHandResult: () => {},
      onNotice: () => {},
      onAudit: () => {}
    },
    { actionSeconds: 1 }
  );

  const playerIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const join = engine.join({ nickname: `P${i + 1}`, socketId: `s${i + 1}` });
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
  return { engine, playerIds, states };
}

function setupTwoPlayers() {
  const states = new Map<string, TableStateDTO>();
  const actionEvents: ActionEvent[] = [];
  const handResults: HandResultDTO[] = [];
  const seen = new Set<string>();

  const engine = new TableEngine(
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
      onActionEvent: (_playerId, event) => {
        const key = `${event.timestamp}:${event.playerId}:${event.action}:${event.amount}:${event.isAuto ? 1 : 0}`;
        if (!seen.has(key)) {
          seen.add(key);
          actionEvents.push(event);
        }
      },
      onHandResult: (_playerId, result) => {
        if (!handResults.find((r) => r.handId === result.handId)) {
          handResults.push(result);
        }
      },
      onNotice: () => {},
      onAudit: () => {}
    },
    { actionSeconds: 1 }
  );

  const j1 = engine.join({ nickname: "A", socketId: "s1" });
  const j2 = engine.join({ nickname: "B", socketId: "s2" });
  if (!j1.ok || !j1.playerId || !j2.ok || !j2.playerId) {
    throw new Error("join failed");
  }
  const p1 = j1.playerId;
  const p2 = j2.playerId;

  expect(engine.sit(p1, 0).ok).toBe(true);
  expect(engine.sit(p2, 1).ok).toBe(true);
  expect(engine.setReady(p1, true).ok).toBe(true);
  expect(engine.setReady(p2, true).ok).toBe(true);
  expect(engine.startHandByHost(p1).ok).toBe(true);

  const getState = (playerId: string): TableStateDTO => {
    const state = states.get(playerId);
    if (!state) {
      throw new Error("missing state");
    }
    return state;
  };

  return { engine, p1, p2, getState, actionEvents, handResults };
}

describe("table engine action visibility", () => {
  it("records blind actions in global stream but not in seat lastAction", () => {
    const { p1, getState, actionEvents } = setupTwoPlayers();
    const state = getState(p1);

    const occupied = state.seats.filter((s) => !!s.playerId);
    for (const seat of occupied) {
      expect(seat.lastAction).toBeNull();
    }

    const blindEvents = actionEvents.filter(
      (e) => e.handId === state.hand.handId && e.action === "bet" && e.street === "preflop" && (e.amount === state.hand.smallBlind || e.amount === state.hand.bigBlind)
    );
    expect(blindEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("updates seat lastAction and emits action event for manual actions", () => {
    const { engine, p1, getState, actionEvents } = setupTwoPlayers();
    const before = getState(p1);

    const toActSeat = before.hand.toActSeat;
    expect(toActSeat).not.toBeNull();
    const actorSeat = before.seats[toActSeat!];
    const actorId = actorSeat.playerId!;
    const callNeed = Math.max(0, before.hand.currentBet - actorSeat.committed);
    const action = callNeed === 0 ? "check" : "fold";

    expect(engine.applyAction(actorId, { handId: before.hand.handId!, action }).ok).toBe(true);

    const after = getState(p1);
    const actedSeat = after.seats.find((s) => s.playerId === actorId)!;
    expect(actedSeat.lastAction?.action).toBe(action);
    expect(actedSeat.lastAction?.isAuto).toBe(false);

    const ev = [...actionEvents].reverse().find((e) => e.playerId === actorId && e.action === action);
    expect(ev).toBeTruthy();
    expect(ev?.isAuto).toBeUndefined();
  });

  it("marks timeout actions as AUTO", () => {
    const { engine, p1, getState, actionEvents } = setupTwoPlayers();
    const before = getState(p1);

    expect(before.hand.actionDeadlineTs).not.toBeNull();
    engine.tick((before.hand.actionDeadlineTs ?? Date.now()) + 1);

    const autoEvent = [...actionEvents].reverse().find((e) => e.isAuto);
    expect(autoEvent).toBeTruthy();

    const after = getState(p1);
    const actedSeat = after.seats.find((s) => s.playerId === autoEvent!.playerId)!;
    expect(actedSeat.lastAction?.isAuto).toBe(true);
  });

  it("clears seat lastAction when a new hand starts", () => {
    const { engine, p1, p2, getState } = setupTwoPlayers();
    const state = getState(p1);

    const actorId = state.seats[state.hand.toActSeat!].playerId!;
    expect(engine.applyAction(actorId, { handId: state.hand.handId!, action: "fold" }).ok).toBe(true);

    expect(engine.setReady(p1, true).ok).toBe(true);
    expect(engine.setReady(p2, true).ok).toBe(true);
    expect(engine.startHandByHost(p1).ok).toBe(true);

    const next = getState(p1);
    const s1 = next.seats.find((s) => s.playerId === p1)!;
    const s2 = next.seats.find((s) => s.playerId === p2)!;
    expect(s1.lastAction).toBeNull();
    expect(s2.lastAction).toBeNull();
  });

  it("assigns heads-up position labels correctly", () => {
    const { p1, p2, getState } = setupTwoPlayers();
    const state = getState(p1);

    const s1 = state.seats.find((s) => s.playerId === p1)!;
    const s2 = state.seats.find((s) => s.playerId === p2)!;
    const labels = [s1.positionLabel, s2.positionLabel].sort();
    expect(labels).toEqual(["大盲", "庄家/小盲"]);
  });

  it("auto runouts board when all remaining players are all-in", () => {
    const { engine, p1, getState, handResults } = setupTwoPlayers();
    const preflop = getState(p1);
    const firstActor = preflop.seats[preflop.hand.toActSeat!].playerId!;
    expect(engine.applyAction(firstActor, { handId: preflop.hand.handId!, action: "allin" }).ok).toBe(true);

    const next = getState(p1);
    const secondActor = next.seats[next.hand.toActSeat!].playerId!;
    expect(engine.applyAction(secondActor, { handId: next.hand.handId!, action: "call" }).ok).toBe(true);

    const settled = getState(p1);
    expect(settled.hand.handId).toBeNull();
    expect(handResults.length).toBeGreaterThan(0);
  });

  it("emits showdown players when reaching river showdown", () => {
    const { engine, p1, getState, handResults } = setupTwoPlayers();

    for (let i = 0; i < 20; i += 1) {
      const state = getState(p1);
      if (!state.hand.handId || state.hand.street === "waiting") {
        break;
      }
      const toAct = state.hand.toActSeat;
      if (toAct === null) {
        break;
      }
      const seat = state.seats[toAct];
      const actorId = seat.playerId!;
      const callNeed = Math.max(0, state.hand.currentBet - seat.committed);
      const action = callNeed > 0 ? "call" : "check";
      const res = engine.applyAction(actorId, { handId: state.hand.handId, action });
      expect(res.ok).toBe(true);
    }

    const result = handResults.at(-1);
    expect(result).toBeTruthy();
    expect(result!.showdownPlayers.length).toBeGreaterThanOrEqual(2);
    expect(result!.showdownPlayers.every((p) => p.holeCards.length === 2)).toBe(true);
  });

  it("assigns 10-max chinese position labels", () => {
    const { playerIds, states } = setupPlayers(10);
    const state = states.get(playerIds[0])!;
    const labels = state.seats.map((s) => s.positionLabel).filter((v): v is string => !!v);
    expect(labels).toEqual(expect.arrayContaining(["庄家", "小盲", "大盲", "枪口", "枪口+1", "枪口+2", "枪口+3", "低位", "劫位", "关煞"]));
  });
});
