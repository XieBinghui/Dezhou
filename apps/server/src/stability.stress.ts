import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionType, TableStateDTO } from "@dezhou/shared";
import { TableEngine } from "./table-engine.js";

type SimPlayer = {
  playerId: string;
  nickname: string;
  token: string;
  socketId: string;
  connected: boolean;
  reconnectAtStep: number | null;
};

type AuditEvent = Record<string, unknown>;
type AuditLog = { ts: number; event: AuditEvent };
type EngineInternals = {
  hand: {
    handId: string;
    toActSeat: number | null;
    currentBet: number;
    minRaiseTo: number;
    actionDeadlineTs: number | null;
    streetContrib: Map<string, number>;
  } | null;
  hostPlayerId: string | null;
  seats: Array<string | null>;
  players: Map<string, { stack: number; pendingRebuy: boolean; seatIndex: number | null }>;
};

const HAND_TARGET = Number(process.env.STRESS_HANDS ?? 100);
const PLAYER_COUNT = Number(process.env.STRESS_PLAYERS ?? 10);
const MAX_STEPS = Number(process.env.STRESS_MAX_STEPS ?? 120_000);
const ACTION_SECONDS = Number(process.env.STRESS_ACTION_SECONDS ?? 2);
const REPORT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/stability-report.json");
const AUDIT_TAIL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/stability-audit-tail.log");

let capturedAudits: AuditLog[] = [];

function writeAuditTail(audits: AuditLog[]): void {
  const tail = audits.slice(-300).map((entry) => JSON.stringify({ ts: entry.ts, ...entry.event }));
  const content = tail.length > 0 ? `${tail.join("\n")}\n` : "no audit events captured\n";
  mkdirSync(dirname(AUDIT_TAIL_PATH), { recursive: true });
  writeFileSync(AUDIT_TAIL_PATH, content, "utf8");
}

let seed = Number(process.env.STRESS_SEED ?? 20260304);
function rand(): number {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function normalizeState(state: TableStateDTO): string {
  const waiting = [...state.waiting].sort((a, b) => a.playerId.localeCompare(b.playerId));
  const seats = state.seats.map((s) => ({
    seatIndex: s.seatIndex,
    playerId: s.playerId,
    nickname: s.nickname,
    stack: s.stack,
    committed: s.committed,
    status: s.status,
    isConnected: s.isConnected,
    isHost: s.isHost,
    isReady: s.isReady,
    positionLabel: s.positionLabel,
    isDealer: s.isDealer,
    inHand: s.inHand,
    pendingRebuy: s.pendingRebuy,
    lastAction: s.lastAction,
    holeCards: null
  }));

  return JSON.stringify({
    tableId: state.tableId,
    maxSeats: state.maxSeats,
    hostPlayerId: state.hostPlayerId,
    readyPlayerIds: [...state.readyPlayerIds].sort(),
    canStartHand: state.canStartHand,
    waitingForReady: state.waitingForReady,
    waiting,
    seats,
    hand: {
      ...state.hand,
      board: state.hand.board
    },
    blindLevel: state.blindLevel,
    buyIn: state.buyIn
  });
}

function chooseAction(
  hand: { currentBet: number; minRaiseTo: number },
  committed: number,
  stack: number
): { action: ActionType; amount?: number } {
  const callNeed = Math.max(0, hand.currentBet - committed);
  const maxStreetTotal = committed + stack;

  if (callNeed > 0) {
    const r = rand();
    if (r < 0.6) {
      return { action: "call" };
    }
    if (r < 0.78) {
      return { action: "fold" };
    }
    if (r < 0.92 && maxStreetTotal > hand.currentBet && maxStreetTotal >= hand.minRaiseTo) {
      return { action: "raise", amount: hand.minRaiseTo };
    }
    return { action: "allin" };
  }

  if (stack <= 0) {
    return { action: "check" };
  }

  const r = rand();
  if (r < 0.72) {
    return { action: "check" };
  }
  if (r < 0.92 && maxStreetTotal >= hand.minRaiseTo) {
    if (hand.currentBet === 0) {
      return { action: "bet", amount: hand.minRaiseTo };
    }
    return { action: "raise", amount: hand.minRaiseTo };
  }
  return { action: "allin" };
}

function assertSync(states: Map<string, TableStateDTO>, players: SimPlayer[]): void {
  const connectedStates = players
    .filter((p) => p.connected)
    .map((p) => ({ playerId: p.playerId, state: states.get(p.playerId) }))
    .filter((x): x is { playerId: string; state: TableStateDTO } => !!x.state);

  if (connectedStates.length <= 1) {
    return;
  }

  const base = normalizeState(connectedStates[0].state);
  for (let i = 1; i < connectedStates.length; i += 1) {
    const next = normalizeState(connectedStates[i].state);
    if (next !== base) {
      throw new Error(`state desync detected between ${connectedStates[0].playerId} and ${connectedStates[i].playerId}`);
    }
  }
}

function run(): void {
  const states = new Map<string, TableStateDTO>();
  const audits: AuditLog[] = [];
  capturedAudits = audits;
  const actionEvents: Array<{ handId: string; timestamp: number; playerId: string; action: string; amount: number; isAuto: boolean }> = [];
  const actionSeen = new Set<string>();

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
        const key = `${event.handId}:${event.timestamp}:${event.playerId}:${event.action}:${event.amount}:${event.isAuto ? 1 : 0}`;
        if (actionSeen.has(key)) {
          return;
        }
        actionSeen.add(key);
        actionEvents.push({
          handId: event.handId,
          timestamp: event.timestamp,
          playerId: event.playerId,
          action: event.action,
          amount: event.amount,
          isAuto: event.isAuto ? true : false
        });
      },
      onHandResult: () => {},
      onNotice: () => {},
      onAudit: (event) => {
        audits.push({ ts: Date.now(), event });
      }
    },
    { actionSeconds: ACTION_SECONDS }
  );
  const core = engine as unknown as EngineInternals;

  const players: SimPlayer[] = [];
  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    const nickname = `S${i + 1}`;
    const socketId = `sock-${i + 1}`;
    const joined = engine.join({ nickname, socketId });
    if (!joined.ok || !joined.playerId || !joined.token) {
      throw new Error("failed to join stress player");
    }
    players.push({
      playerId: joined.playerId,
      nickname,
      token: joined.token,
      socketId,
      connected: true,
      reconnectAtStep: null
    });
    const sit = engine.sit(joined.playerId, i);
    if (!sit.ok) {
      throw new Error(`failed to sit player ${nickname}: ${sit.reason}`);
    }
  }

  let disconnectCount = 0;
  let reconnectCount = 0;
  let timeoutCount = 0;
  let rejectedActionCount = 0;
  let forcedDisconnectDone = false;
  let forcedTimeoutDone = false;
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps += 1;
    const handEndCount = audits.filter((e) => e.event.type === "hand_end").length;
    if (handEndCount >= HAND_TARGET) {
      break;
    }

    for (const p of players) {
      if (!p.connected && p.reconnectAtStep !== null && p.reconnectAtStep <= steps) {
        const newSocketId = `${p.socketId}-r${steps}`;
        const rejoin = engine.join({ nickname: p.nickname, token: p.token, socketId: newSocketId });
        if (rejoin.ok && rejoin.playerId === p.playerId) {
          p.connected = true;
          p.socketId = newSocketId;
          p.reconnectAtStep = null;
          reconnectCount += 1;
        }
      }
    }

    if (!core.hand) {
      for (const pid of core.seats) {
        if (!pid) {
          continue;
        }
        const session = core.players.get(pid);
        if (!session) {
          continue;
        }
        if (session.stack === 0 && !session.pendingRebuy) {
          engine.rebuy(pid);
        }
        engine.setReady(pid, true);
      }
      const hostPlayerId = core.hostPlayerId ?? players[0].playerId;
      const start = engine.startHandByHost(hostPlayerId);
      if (!start.ok) {
        throw new Error(`failed to start hand: ${start.reason}`);
      }
      assertSync(states, players);
      continue;
    }

    if (!forcedDisconnectDone) {
      const connected = players.filter((p) => p.connected);
      if (connected.length > 2) {
        const victim = connected[Math.floor(rand() * connected.length)];
        engine.disconnect(victim.playerId, victim.socketId);
        victim.connected = false;
        victim.reconnectAtStep = steps + 2;
        disconnectCount += 1;
        forcedDisconnectDone = true;
      }
    } else if (rand() < 0.06) {
      const connected = players.filter((p) => p.connected);
      if (connected.length > 2) {
        const victim = connected[Math.floor(rand() * connected.length)];
        engine.disconnect(victim.playerId, victim.socketId);
        victim.connected = false;
        victim.reconnectAtStep = steps + 1 + Math.floor(rand() * 5);
        disconnectCount += 1;
      }
    }

    if (!core.hand || core.hand.toActSeat === null) {
      assertSync(states, players);
      continue;
    }
    const actorId = core.seats[core.hand.toActSeat];
    if (!actorId) {
      assertSync(states, players);
      continue;
    }
    const actorSession = core.players.get(actorId);
    if (!actorSession) {
      assertSync(states, players);
      continue;
    }
    const committed = core.hand.streetContrib.get(actorId) ?? 0;
    const actor = players.find((p) => p.playerId === actorId);
    const shouldTimeout = !forcedTimeoutDone || rand() < 0.14;
    if (!actor || !actor.connected || shouldTimeout) {
      if (core.hand.actionDeadlineTs !== null) {
        engine.tick(core.hand.actionDeadlineTs + 1);
        timeoutCount += 1;
        forcedTimeoutDone = true;
      }
      assertSync(states, players);
      continue;
    }

    const planned = chooseAction(core.hand, committed, actorSession.stack);
    let result = engine.applyAction(actorId, {
      handId: core.hand.handId,
      action: planned.action,
      amount: planned.amount
    });

    if (!result.ok) {
      rejectedActionCount += 1;
      const callNeed = Math.max(0, core.hand.currentBet - committed);
      result = engine.applyAction(actorId, {
        handId: core.hand.handId,
        action: callNeed > 0 ? "call" : "check"
      });
      if (!result.ok) {
        result = engine.applyAction(actorId, {
          handId: core.hand.handId,
          action: "fold"
        });
      }
    }

    if (!result.ok) {
      throw new Error(`action failed irrecoverably: ${result.reason}`);
    }

    assertSync(states, players);
  }

  const handStarts = audits
    .filter((e) => e.event.type === "hand_start")
    .map((e) => ({ ts: e.ts, handId: String(e.event.handId ?? "") }));
  const handEnds = audits
    .filter((e) => e.event.type === "hand_end")
    .map((e) => ({ ts: e.ts, handId: String(e.event.handId ?? "") }));

  if (handEnds.length < HAND_TARGET) {
    throw new Error(
      `stress did not finish target hands: ${handEnds.length}/${HAND_TARGET} (handStarts=${handStarts.length}, steps=${steps}, activeHand=${core.hand ? 1 : 0})`
    );
  }

  if (!forcedDisconnectDone || reconnectCount === 0 || !forcedTimeoutDone || timeoutCount === 0) {
    throw new Error("stress did not exercise disconnect/reconnect/timeout paths");
  }

  const startIds = new Set(handStarts.map((e) => e.handId));
  const endIds = new Set(handEnds.map((e) => e.handId));

  for (const handId of startIds) {
    if (!endIds.has(handId)) {
      throw new Error(`traceability failed: hand ${handId} has start but no end`);
    }
  }

  const actionByHand = new Map<string, number>();
  for (const event of actionEvents) {
    if (!event.handId || !event.playerId || !Number.isFinite(event.timestamp)) {
      throw new Error("traceability failed: malformed action event");
    }
    actionByHand.set(event.handId, (actionByHand.get(event.handId) ?? 0) + 1);
  }

  for (const handId of startIds) {
    if ((actionByHand.get(handId) ?? 0) < 2) {
      throw new Error(`traceability failed: hand ${handId} has too few action events`);
    }
  }

  const startTs = new Map(handStarts.map((e) => [e.handId, e.ts]));
  const handDurations: number[] = [];
  for (const end of handEnds) {
    const st = startTs.get(end.handId);
    if (st) {
      handDurations.push(end.ts - st);
    }
  }
  const averageHandMs =
    handDurations.length > 0 ? Math.round(handDurations.reduce((sum, cur) => sum + cur, 0) / handDurations.length) : 0;

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      HAND_TARGET,
      PLAYER_COUNT,
      MAX_STEPS,
      ACTION_SECONDS,
      seed: Number(process.env.STRESS_SEED ?? 20260304)
    },
    counts: {
      handStarts: handStarts.length,
      handEnds: handEnds.length,
      actionEvents: actionEvents.length,
      disconnectCount,
      reconnectCount,
      timeoutCount,
      rejectedActionCount,
      steps
    },
    metrics: {
      averageHandMs
    },
    checks: {
      noBlockingRuleError: true,
      noStateDesync: true,
      traceableAudit: true,
      exercisedDisconnectReconnect: true,
      exercisedTimeout: true
    }
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  writeAuditTail(audits);
  // eslint-disable-next-line no-console
  console.log("stability stress passed", report);
}

try {
  run();
} catch (error) {
  const failReport = {
    ok: false,
    generatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(failReport, null, 2), "utf8");
  writeAuditTail(capturedAudits);
  // eslint-disable-next-line no-console
  console.error("stability stress failed", failReport);
  process.exitCode = 1;
}
