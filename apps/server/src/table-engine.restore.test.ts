import { describe, expect, it } from "vitest";
import type { TableStateDTO } from "@dezhou/shared";
import { TableEngine } from "./table-engine.js";

function makeEngine(states: Map<string, TableStateDTO>): TableEngine {
  return new TableEngine(
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
    { actionSeconds: 3 }
  );
}

describe("table engine snapshot restore", () => {
  it("restores running table from snapshot", () => {
    const states1 = new Map<string, TableStateDTO>();
    const engine1 = makeEngine(states1);
    const j1 = engine1.join({ nickname: "A", socketId: "s1" });
    const j2 = engine1.join({ nickname: "B", socketId: "s2" });
    if (!j1.ok || !j1.playerId || !j1.token || !j2.ok || !j2.playerId) {
      throw new Error("join failed");
    }
    expect(engine1.sit(j1.playerId, 0).ok).toBe(true);
    expect(engine1.sit(j2.playerId, 1).ok).toBe(true);
    expect(engine1.setReady(j1.playerId, true).ok).toBe(true);
    expect(engine1.setReady(j2.playerId, true).ok).toBe(true);
    expect(engine1.startHandByHost(j1.playerId).ok).toBe(true);

    const before = states1.get(j1.playerId);
    expect(before?.hand.handId).toBeTruthy();
    const snapshot = engine1.dumpSnapshot();

    const states2 = new Map<string, TableStateDTO>();
    const engine2 = makeEngine(states2);
    expect(engine2.restoreFromSnapshot(snapshot).ok).toBe(true);

    const rejoin = engine2.join({ nickname: "A", token: j1.token, socketId: "s1x" });
    expect(rejoin.ok).toBe(true);
    const after = states2.get(j1.playerId);
    expect(after?.hand.handId).toBe(before?.hand.handId);
    expect(after?.seats[0].nickname).toBe("A");
    expect(after?.seats[1].nickname).toBe("B");
  });
});
