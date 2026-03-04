import { nanoid } from "nanoid";
import type {
  ActionRecordDTO,
  ActionType,
  Card,
  HandResultDTO,
  PartialGameStateDTO,
  SeatLastActionDTO,
  SeatState,
  ShowdownPlayerDTO,
  Street,
  TableStateDTO
} from "@dezhou/shared";
import { createDeck, deal, shuffleDeck } from "./cards.js";
import { evaluateSeven, compareHandScore } from "./evaluator.js";
import { buildPots, type Contribution } from "./pot-manager.js";

interface PlayerSession {
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

interface HandRuntime {
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
  streetContrib: Map<string, number>;
  totalContrib: Map<string, number>;
  hasActed: Map<string, boolean>;
  folded: Set<string>;
  allIn: Set<string>;
  holeCards: Map<string, [Card, Card]>;
  actionLog: ActionRecordDTO[];
  pots: Array<{ amount: number; eligiblePlayerIds: string[] }>;
  positionLabels: Map<string, string>;
}

interface Config {
  tableId: string;
  maxSeats: number;
  sb: number;
  bb: number;
  buyIn: number;
  actionSeconds: number;
}

interface Hooks {
  onTableState: (recipientPlayerId: string, state: TableStateDTO) => void;
  onStateChanged: (recipientPlayerId: string, partial: PartialGameStateDTO) => void;
  onActionEvent: (recipientPlayerId: string, event: ActionRecordDTO & { isAuto?: boolean }) => void;
  onHandResult: (recipientPlayerId: string, result: HandResultDTO) => void;
  onNotice: (recipientPlayerId: string, notice: { type: "info" | "warn" | "error"; message: string }) => void;
  onAudit: (event: Record<string, unknown>) => void;
}

export class TableEngine {
  private readonly cfg: Config;
  private readonly hooks: Hooks;
  private readonly players = new Map<string, PlayerSession>();
  private readonly seats: Array<string | null>;
  private readonly waiting: string[] = [];
  private hostPlayerId: string | null = null;
  private buttonPos = -1;
  private hand: HandRuntime | null = null;

  constructor(hooks: Hooks, overrides?: Partial<Config>) {
    this.cfg = {
      tableId: "main-table",
      maxSeats: 10,
      sb: 1,
      bb: 2,
      buyIn: 200,
      actionSeconds: 20,
      ...overrides
    };
    this.hooks = hooks;
    this.seats = Array.from({ length: this.cfg.maxSeats }, () => null);
  }

  join(payload: { nickname: string; token?: string; socketId: string }): { ok: boolean; reason?: string; token?: string; playerId?: string } {
    const name = payload.nickname.trim().slice(0, 20);
    if (!name) {
      return { ok: false, reason: "昵称不能为空" };
    }

    if (payload.token) {
      const old = [...this.players.values()].find((p) => p.token === payload.token);
      if (old) {
        if (old.disconnectedAt && Date.now() - old.disconnectedAt > 30_000) {
          return { ok: false, reason: "重连令牌已过期" };
        }
        old.socketId = payload.socketId;
        old.isConnected = true;
        old.disconnectedAt = null;
        this.pushFullState(old.playerId);
        this.broadcastAllStates();
        return { ok: true, token: old.token, playerId: old.playerId };
      }
    }

    const playerId = nanoid(10);
    const token = nanoid(24);
    const player: PlayerSession = {
      playerId,
      nickname: name,
      token,
      socketId: payload.socketId,
      isConnected: true,
      disconnectedAt: null,
      seatIndex: null,
      stack: this.cfg.buyIn,
      pendingRebuy: false,
      ready: false,
      lastAction: null
    };
    this.players.set(playerId, player);
    if (!this.hostPlayerId) {
      this.hostPlayerId = playerId;
    }
    this.waiting.push(playerId);
    this.pushNotice(playerId, "info", "已进入等待区，请选择座位");
    this.pushFullState(playerId);
    this.broadcastAllStates();
    return { ok: true, token, playerId };
  }

  disconnect(playerId: string, socketId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.socketId !== socketId) {
      return;
    }
    player.isConnected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    if (this.hostPlayerId === playerId) {
      this.hostPlayerId = null;
      this.ensureHost();
    }
    this.broadcastAllStates();
  }

  sit(playerId: string, seatIndex: number): { ok: boolean; reason?: string } {
    const player = this.players.get(playerId);
    if (!player) {
      return { ok: false, reason: "玩家不存在" };
    }
    if (seatIndex < 0 || seatIndex >= this.cfg.maxSeats) {
      return { ok: false, reason: "座位无效" };
    }
    if (this.seats[seatIndex]) {
      return { ok: false, reason: "座位已被占用" };
    }

    if (player.seatIndex !== null) {
      this.seats[player.seatIndex] = null;
    }
    player.seatIndex = seatIndex;
    player.ready = false;
    this.seats[seatIndex] = player.playerId;
    this.removeFromWaiting(player.playerId);
    this.broadcastAllStates();
    return { ok: true };
  }

  leaveSeat(playerId: string): { ok: boolean; reason?: string } {
    const player = this.players.get(playerId);
    if (!player) {
      return { ok: false, reason: "玩家不存在" };
    }
    if (player.seatIndex === null) {
      return { ok: false, reason: "未在座位上" };
    }
    if (this.hand && this.hand.holeCards.has(playerId) && !this.hand.folded.has(playerId)) {
      this.applyAction(playerId, { handId: this.hand.handId, action: "fold" });
    }
    this.seats[player.seatIndex] = null;
    player.seatIndex = null;
    player.ready = false;
    this.waiting.push(player.playerId);
    this.ensureHost();
    this.broadcastAllStates();
    return { ok: true };
  }

  rebuy(playerId: string): { ok: boolean; reason?: string } {
    const player = this.players.get(playerId);
    if (!player) {
      return { ok: false, reason: "玩家不存在" };
    }
    if (player.stack > 0) {
      return { ok: false, reason: "当前筹码未清零，不能补码" };
    }
    player.pendingRebuy = true;
    this.pushNotice(playerId, "info", "已申请补码，下手牌生效");
    return { ok: true };
  }

  setReady(playerId: string, ready: boolean): { ok: boolean; reason?: string } {
    const player = this.players.get(playerId);
    if (!player) {
      return { ok: false, reason: "玩家不存在" };
    }
    if (player.seatIndex === null) {
      return { ok: false, reason: "请先入座" };
    }
    if (player.stack <= 0 && !player.pendingRebuy) {
      return { ok: false, reason: "请先补码后再准备" };
    }
    if (this.hand) {
      return { ok: false, reason: "牌局进行中，不能修改准备状态" };
    }
    player.ready = ready;
    this.broadcastAllStates();
    return { ok: true };
  }

  startHandByHost(playerId: string): { ok: boolean; reason?: string } {
    if (playerId !== this.hostPlayerId) {
      return { ok: false, reason: "只有房主可以开局" };
    }
    if (this.hand) {
      return { ok: false, reason: "牌局进行中" };
    }
    const eligible = this.eligibleForHand();
    if (eligible.length < 2) {
      return { ok: false, reason: "至少需要2名可用玩家" };
    }
    const notReady = eligible.filter((p) => !p.ready);
    if (notReady.length > 0) {
      return { ok: false, reason: "仍有玩家未准备" };
    }
    this.startHand();
    return { ok: true };
  }

  applyAction(
    playerId: string,
    payload: { handId: string; action: ActionType; amount?: number },
    meta?: { isAuto?: boolean }
  ): { ok: boolean; reason?: string } {
    const hand = this.hand;
    const player = this.players.get(playerId);
    if (!hand || !player) {
      return { ok: false, reason: "当前没有进行中的牌局" };
    }
    if (payload.handId !== hand.handId) {
      return { ok: false, reason: "手牌编号不匹配" };
    }
    if (player.seatIndex === null || hand.toActSeat !== player.seatIndex) {
      return { ok: false, reason: "尚未轮到你行动" };
    }
    if (hand.folded.has(playerId) || hand.allIn.has(playerId)) {
      return { ok: false, reason: "当前不可行动" };
    }

    const streetPaid = hand.streetContrib.get(playerId) ?? 0;
    const callNeed = Math.max(0, hand.currentBet - streetPaid);
    const maxTotalStreet = streetPaid + player.stack;

    const doCommit = (toStreetTotal: number): number => {
      const delta = toStreetTotal - streetPaid;
      player.stack -= delta;
      hand.streetContrib.set(playerId, toStreetTotal);
      hand.totalContrib.set(playerId, (hand.totalContrib.get(playerId) ?? 0) + delta);
      return delta;
    };

    const markActed = () => {
      hand.hasActed.set(playerId, true);
    };

    const addLog = (action: ActionType, amount: number) => {
      const event: ActionRecordDTO & { isAuto?: boolean } = {
        handId: hand.handId,
        timestamp: Date.now(),
        playerId,
        nickname: player.nickname,
        street: hand.street,
        action,
        amount,
        isAuto: meta?.isAuto ? true : undefined
      };
      hand.actionLog.push(event);
      player.lastAction = {
        action,
        amount,
        street: hand.street,
        at: event.timestamp,
        isAuto: meta?.isAuto ? true : false
      };
      this.broadcastActionEvent(event);
      this.hooks.onAudit({
        type: "action",
        handId: hand.handId,
        playerId,
        action,
        amount,
        street: hand.street,
        isAuto: meta?.isAuto ? true : false
      });
    };

    let actionAmount = 0;
    if (payload.action === "fold") {
      hand.folded.add(playerId);
      markActed();
      addLog("fold", 0);
    } else if (payload.action === "check") {
      if (callNeed !== 0) {
        return { ok: false, reason: "当前不能过牌" };
      }
      markActed();
      addLog("check", 0);
    } else if (payload.action === "call") {
      if (callNeed === 0) {
        return { ok: false, reason: "当前无需跟注" };
      }
      const toPut = Math.min(callNeed, player.stack);
      const toStreetTotal = streetPaid + toPut;
      doCommit(toStreetTotal);
      actionAmount = toPut;
      if (player.stack === 0) {
        hand.allIn.add(playerId);
      }
      markActed();
      addLog("call", actionAmount);
    } else {
      const target = payload.action === "allin" ? maxTotalStreet : payload.amount;
      if (target === undefined || !Number.isFinite(target)) {
        return { ok: false, reason: "加注金额无效" };
      }
      if (target <= streetPaid) {
        return { ok: false, reason: "下注金额不足" };
      }
      if (target > maxTotalStreet) {
        return { ok: false, reason: "筹码不足" };
      }

      if (hand.currentBet === 0) {
        const minBet = this.cfg.bb;
        if (target < minBet && target !== maxTotalStreet) {
          return { ok: false, reason: `最小下注为 ${minBet}` };
        }
        doCommit(target);
        hand.currentBet = target;
        hand.minRaiseTo = hand.currentBet + hand.lastFullRaiseSize;
        const raiseSize = target;
        if (raiseSize >= hand.lastFullRaiseSize) {
          hand.lastFullRaiseSize = raiseSize;
          this.resetActedExcept(playerId);
        }
        markActed();
        actionAmount = target - streetPaid;
        addLog(payload.action === "allin" ? "allin" : "bet", actionAmount);
      } else {
        if (target <= hand.currentBet) {
          return { ok: false, reason: "请使用跟注或过牌" };
        }
        const raiseSize = target - hand.currentBet;
        const isAllIn = target === maxTotalStreet;
        if (target < hand.minRaiseTo && !isAllIn) {
          return { ok: false, reason: `最小加注到 ${hand.minRaiseTo}` };
        }
        doCommit(target);
        hand.currentBet = Math.max(hand.currentBet, target);
        actionAmount = target - streetPaid;
        const isFullRaise = raiseSize >= hand.lastFullRaiseSize;
        if (isFullRaise) {
          hand.lastFullRaiseSize = raiseSize;
          hand.minRaiseTo = hand.currentBet + hand.lastFullRaiseSize;
          this.resetActedExcept(playerId);
        }
        markActed();
        addLog(payload.action === "allin" ? "allin" : "raise", actionAmount);
      }

      if (player.stack === 0) {
        hand.allIn.add(playerId);
      }
    }

    if (this.activeNotFoldedCount() <= 1) {
      this.finishHand();
      return { ok: true };
    }

    if (this.isBettingRoundComplete()) {
      this.advanceStreetOrFinish();
    } else {
      this.moveToNextActor();
    }

    this.broadcastIncremental();
    return { ok: true };
  }

  tick(now = Date.now()): void {
    const hand = this.hand;
    if (!hand || hand.toActSeat === null || hand.actionDeadlineTs === null) {
      return;
    }
    if (now < hand.actionDeadlineTs) {
      return;
    }

    const pid = this.seats[hand.toActSeat];
    if (!pid) {
      this.moveToNextActor();
      this.broadcastIncremental();
      return;
    }

    const callNeed = Math.max(0, hand.currentBet - (hand.streetContrib.get(pid) ?? 0));
    const action: ActionType = callNeed === 0 ? "check" : "fold";
    this.applyAction(pid, { handId: hand.handId, action }, { isAuto: true });
    this.pushNotice(pid, "warn", callNeed === 0 ? "你已超时，系统自动过牌" : "你已超时，系统自动弃牌");
  }

  getPlayerIdBySocket(socketId: string): string | null {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        return p.playerId;
      }
    }
    return null;
  }

  getSocketId(playerId: string): string | null {
    return this.players.get(playerId)?.socketId ?? null;
  }

  private activeSeatedPlayers(): PlayerSession[] {
    return [...this.players.values()].filter((p) => p.seatIndex !== null);
  }

  private eligibleForHand(): PlayerSession[] {
    return this.activeSeatedPlayers().filter((p) => p.stack > 0 || p.pendingRebuy);
  }

  private startHand(): void {
    const eligible = this.eligibleForHand().filter((p) => p.ready);
    for (const p of eligible) {
      p.lastAction = null;
    }
    for (const p of eligible) {
      if (p.pendingRebuy && p.stack === 0) {
        p.stack = this.cfg.buyIn;
        p.pendingRebuy = false;
      }
    }

    const deck = shuffleDeck(createDeck());
    const handId = nanoid(12);
    const handPlayers = new Set(eligible.map((p) => p.playerId));
    this.buttonPos = this.nextEligibleSeat(this.buttonPos, handPlayers);
    const sbSeat = handPlayers.size === 2 ? this.buttonPos : this.nextEligibleSeat(this.buttonPos, handPlayers);
    const bbSeat = this.nextEligibleSeat(sbSeat, handPlayers);

    const runtime: HandRuntime = {
      handId,
      deck,
      board: [],
      street: "preflop",
      toActSeat: null,
      currentBet: 0,
      minRaiseTo: this.cfg.bb,
      lastFullRaiseSize: this.cfg.bb,
      actionDeadlineTs: null,
      startedAt: Date.now(),
      showdownAt: null,
      streetContrib: new Map(),
      totalContrib: new Map(),
      hasActed: new Map(),
      folded: new Set(),
      allIn: new Set(),
      holeCards: new Map(),
      actionLog: [],
      pots: [],
      positionLabels: new Map()
    };

    this.hand = runtime;

    for (const seatPid of this.seats) {
      if (!seatPid) {
        continue;
      }
      runtime.streetContrib.set(seatPid, 0);
      runtime.totalContrib.set(seatPid, 0);
      runtime.hasActed.set(seatPid, false);
      const p = this.players.get(seatPid)!;
      if (p.stack <= 0) {
        runtime.folded.add(seatPid);
      }
    }

    for (const p of eligible) {
      if (p.stack <= 0) {
        continue;
      }
      const [c1, c2] = deal(runtime.deck, 2) as [Card, Card];
      runtime.holeCards.set(p.playerId, [c1, c2]);
    }

    this.postBlind(sbSeat, this.cfg.sb);
    this.postBlind(bbSeat, this.cfg.bb);
    runtime.positionLabels = this.buildPositionLabels(handPlayers, this.buttonPos, sbSeat, bbSeat);

    runtime.currentBet = Math.max(this.cfg.bb, runtime.streetContrib.get(this.seats[bbSeat]!) ?? 0);
    runtime.minRaiseTo = runtime.currentBet + runtime.lastFullRaiseSize;
    runtime.toActSeat = this.nextActorFrom(bbSeat);
    this.armDeadline();
    this.broadcastAllStates();
    this.hooks.onAudit({ type: "hand_start", handId, buttonPos: this.buttonPos, sbSeat, bbSeat });
  }

  private postBlind(seat: number, amount: number): void {
    const pid = this.seats[seat];
    if (!pid || !this.hand) {
      return;
    }
    const p = this.players.get(pid)!;
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    this.hand.streetContrib.set(pid, pay);
    this.hand.totalContrib.set(pid, pay);
    if (p.stack === 0) {
      this.hand.allIn.add(pid);
    }
    const event: ActionRecordDTO = {
      handId: this.hand.handId,
      timestamp: Date.now(),
      playerId: pid,
      nickname: p.nickname,
      street: "preflop",
      action: "bet",
      amount: pay
    };
    this.hand.actionLog.push(event);
    this.broadcastActionEvent(event);
  }

  private nextEligibleSeat(start: number, allowedPlayers?: Set<string>): number {
    for (let i = 1; i <= this.cfg.maxSeats; i += 1) {
      const seat = (start + i + this.cfg.maxSeats) % this.cfg.maxSeats;
      const pid = this.seats[seat];
      if (!pid) {
        continue;
      }
      if (allowedPlayers && !allowedPlayers.has(pid)) {
        continue;
      }
      const p = this.players.get(pid)!;
      if (p.stack > 0 || p.pendingRebuy) {
        return seat;
      }
    }
    return start;
  }

  private seatTraversal(fromSeat: number, untilExclusiveSeat: number): number[] {
    const seats: number[] = [];
    let cursor = fromSeat;
    while (true) {
      cursor = (cursor + 1) % this.cfg.maxSeats;
      if (cursor === untilExclusiveSeat) {
        break;
      }
      seats.push(cursor);
    }
    return seats;
  }

  private buildPositionLabels(handPlayers: Set<string>, buttonSeat: number, sbSeat: number, bbSeat: number): Map<string, string> {
    const labels = new Map<string, string>();
    const buttonPid = this.seats[buttonSeat];
    const sbPid = this.seats[sbSeat];
    const bbPid = this.seats[bbSeat];
    if (!buttonPid || !sbPid || !bbPid) {
      return labels;
    }

    if (handPlayers.size === 2) {
      labels.set(buttonPid, "庄家/小盲");
      labels.set(bbPid, "大盲");
      return labels;
    }

    labels.set(buttonPid, "庄家");
    labels.set(sbPid, "小盲");
    labels.set(bbPid, "大盲");

    const remainingSeats = this.seatTraversal(bbSeat, buttonSeat).filter((seat) => {
      const pid = this.seats[seat];
      return !!pid && handPlayers.has(pid);
    });

    const earlyLabels = ["枪口", "枪口+1", "枪口+2", "枪口+3"];
    const lateLabels = ["低位", "劫位", "关煞"];
    const lateCount = Math.min(3, remainingSeats.length);
    const earlyCount = remainingSeats.length - lateCount;

    for (let i = 0; i < earlyCount; i += 1) {
      const pid = this.seats[remainingSeats[i]];
      if (!pid) {
        continue;
      }
      labels.set(pid, earlyLabels[i] ?? `枪口+${i}`);
    }

    for (let j = 0; j < lateCount; j += 1) {
      const seat = remainingSeats[earlyCount + j];
      const pid = this.seats[seat];
      if (!pid) {
        continue;
      }
      const label = lateLabels[lateLabels.length - lateCount + j];
      labels.set(pid, label);
    }

    return labels;
  }

  private nextActorFrom(seat: number): number | null {
    if (!this.hand) {
      return null;
    }
    for (let i = 1; i <= this.cfg.maxSeats; i += 1) {
      const idx = (seat + i) % this.cfg.maxSeats;
      const pid = this.seats[idx];
      if (!pid) {
        continue;
      }
      if (this.hand.folded.has(pid) || this.hand.allIn.has(pid) || !this.hand.holeCards.has(pid)) {
        continue;
      }
      return idx;
    }
    return null;
  }

  private moveToNextActor(): void {
    if (!this.hand || this.hand.toActSeat === null) {
      return;
    }
    const next = this.nextActorFrom(this.hand.toActSeat);
    this.hand.toActSeat = next;
    this.armDeadline();
  }

  private armDeadline(): void {
    if (!this.hand || this.hand.toActSeat === null) {
      return;
    }
    this.hand.actionDeadlineTs = Date.now() + this.cfg.actionSeconds * 1000;
  }

  private activeNotFoldedCount(): number {
    if (!this.hand) {
      return 0;
    }
    let count = 0;
    for (const pid of this.hand.holeCards.keys()) {
      if (!this.hand.folded.has(pid)) {
        count += 1;
      }
    }
    return count;
  }

  private isBettingRoundComplete(): boolean {
    if (!this.hand) {
      return false;
    }
    for (const pid of this.hand.holeCards.keys()) {
      if (this.hand.folded.has(pid) || this.hand.allIn.has(pid)) {
        continue;
      }
      const acted = this.hand.hasActed.get(pid) ?? false;
      const paid = this.hand.streetContrib.get(pid) ?? 0;
      if (!acted || paid !== this.hand.currentBet) {
        return false;
      }
    }
    return true;
  }

  private resetActedExcept(playerId: string): void {
    if (!this.hand) {
      return;
    }
    for (const pid of this.hand.holeCards.keys()) {
      if (pid === playerId) {
        continue;
      }
      if (this.hand.folded.has(pid) || this.hand.allIn.has(pid)) {
        continue;
      }
      this.hand.hasActed.set(pid, false);
    }
  }

  private advanceStreetOrFinish(): void {
    if (!this.hand) {
      return;
    }
    if (this.hand.street === "river") {
      this.finishHand();
      return;
    }

    this.hand.streetContrib = new Map([...this.hand.streetContrib.keys()].map((pid) => [pid, 0]));
    this.hand.currentBet = 0;
    this.hand.lastFullRaiseSize = this.cfg.bb;
    this.hand.minRaiseTo = this.cfg.bb;

    if (this.hand.street === "preflop") {
      this.hand.board.push(...deal(this.hand.deck, 3));
      this.hand.street = "flop";
    } else if (this.hand.street === "flop") {
      this.hand.board.push(...deal(this.hand.deck, 1));
      this.hand.street = "turn";
    } else if (this.hand.street === "turn") {
      this.hand.board.push(...deal(this.hand.deck, 1));
      this.hand.street = "river";
    }

    for (const pid of this.hand.holeCards.keys()) {
      this.hand.hasActed.set(pid, this.hand.folded.has(pid) || this.hand.allIn.has(pid));
    }

    this.hand.toActSeat = this.nextActorFrom(this.buttonPos);
    this.armDeadline();
  }

  private finishHand(): void {
    const hand = this.hand;
    if (!hand) {
      return;
    }

    hand.street = "showdown";
    hand.showdownAt = Date.now();
    hand.toActSeat = null;
    hand.actionDeadlineTs = null;

    const contributions: Contribution[] = [];
    for (const [pid, amount] of hand.totalContrib.entries()) {
      contributions.push({ playerId: pid, amount, folded: hand.folded.has(pid) });
    }
    const pots = buildPots(contributions);
    hand.pots = pots;

    const winMap = new Map<string, { amount: number; handName: string; cards: Card[] }>();

    for (const pot of pots) {
      const contenders = pot.eligiblePlayerIds;
      if (contenders.length === 0) {
        continue;
      }
      if (hand.board.length < 5) {
        const winnerId = contenders[0];
        const winner = this.players.get(winnerId);
        if (!winner) {
          continue;
        }
        winner.stack += pot.amount;
        const existing = winMap.get(winnerId);
        if (existing) {
          existing.amount += pot.amount;
        } else {
          winMap.set(winnerId, {
            amount: pot.amount,
            handName: "弃牌获胜",
            cards: [...(hand.holeCards.get(winnerId) ?? []), ...hand.board]
          });
        }
        continue;
      }
      let bestPid: string[] = [];
      let bestScore: ReturnType<typeof evaluateSeven> | null = null;
      for (const pid of contenders) {
        const hole = hand.holeCards.get(pid);
        if (!hole) {
          continue;
        }
        const score = evaluateSeven([...hole, ...hand.board]);
        if (!bestScore || compareHandScore(score, bestScore) > 0) {
          bestScore = score;
          bestPid = [pid];
        } else if (compareHandScore(score, bestScore) === 0) {
          bestPid.push(pid);
        }
      }

      if (!bestScore || bestPid.length === 0) {
        continue;
      }

      const base = Math.floor(pot.amount / bestPid.length);
      let remainder = pot.amount % bestPid.length;
      const orderedWinners = [...bestPid].sort((a, b) => {
        const sa = this.players.get(a)?.seatIndex ?? 0;
        const sb = this.players.get(b)?.seatIndex ?? 0;
        return sa - sb;
      });

      for (const pid of orderedWinners) {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        const gain = base + extra;
        const player = this.players.get(pid)!;
        player.stack += gain;
        const existing = winMap.get(pid);
        if (existing) {
          existing.amount += gain;
        } else {
          winMap.set(pid, { amount: gain, handName: bestScore.name, cards: bestScore.bestFive });
        }
      }
    }

    const winners = [...winMap.entries()].map(([pid, v]) => ({
      playerId: pid,
      nickname: this.players.get(pid)?.nickname ?? "",
      amount: v.amount,
      handName: v.handName,
      cards: v.cards
    }));

    const showdownPlayers: ShowdownPlayerDTO[] = [];
    const showdownIds = hand.board.length === 5 ? [...hand.holeCards.keys()].filter((pid) => !hand.folded.has(pid)) : [];
    if (showdownIds.length >= 2) {
      for (const pid of showdownIds) {
        const holeCards = hand.holeCards.get(pid);
        const player = this.players.get(pid);
        if (!holeCards || !player || player.seatIndex === null) {
          continue;
        }
        const score = evaluateSeven([...holeCards, ...hand.board]);
        const winAmount = winMap.get(pid)?.amount ?? 0;
        showdownPlayers.push({
          playerId: pid,
          nickname: player.nickname,
          seatIndex: player.seatIndex,
          positionLabel: hand.positionLabels.get(pid) ?? null,
          holeCards,
          bestFive: score.bestFive,
          handName: score.name,
          isWinner: winAmount > 0,
          winAmount
        });
      }
      showdownPlayers.sort((a, b) => a.seatIndex - b.seatIndex);
    }

    const result: HandResultDTO = {
      handId: hand.handId,
      board: [...hand.board],
      winners,
      showdownPlayers,
      pots,
      actionLog: [...hand.actionLog]
    };

    this.hooks.onAudit({ type: "hand_end", handId: hand.handId, winners: winners.map((w) => ({ id: w.playerId, amount: w.amount })) });

    for (const player of this.players.values()) {
      if (!player.socketId) {
        continue;
      }
      this.hooks.onHandResult(player.playerId, result);
    }

    for (const p of this.activeSeatedPlayers()) {
      p.ready = false;
    }
    this.hand = null;
    this.ensureHost();
    this.broadcastAllStates();
  }

  private buildSeatView(recipientPlayerId: string): SeatState[] {
    return this.seats.map((pid, seatIndex) => {
      if (!pid) {
        return {
          seatIndex,
          playerId: null,
          nickname: null,
          stack: 0,
          committed: 0,
          status: "empty",
          isConnected: false,
          isHost: false,
          isReady: false,
          positionLabel: null,
          isDealer: seatIndex === this.buttonPos,
          inHand: false,
          holeCards: null,
          pendingRebuy: false,
          lastAction: null
        };
      }
      const p = this.players.get(pid)!;
      const inHand = !!this.hand?.holeCards.has(pid);
      const folded = this.hand?.folded.has(pid) ?? false;
      const allIn = this.hand?.allIn.has(pid) ?? false;
      const committed = this.hand?.streetContrib.get(pid) ?? 0;
      const status = folded ? "folded" : allIn ? "allin" : p.stack === 0 ? "out" : "seated";
      const hole = this.hand?.holeCards.get(pid) ?? null;
      return {
        seatIndex,
        playerId: pid,
        nickname: p.nickname,
        stack: p.stack,
        committed,
        status,
        isConnected: p.isConnected,
        isHost: pid === this.hostPlayerId,
        isReady: p.ready,
        positionLabel: this.hand?.positionLabels.get(pid) ?? null,
        isDealer: seatIndex === this.buttonPos,
        inHand,
        holeCards: pid === recipientPlayerId ? hole : null,
        pendingRebuy: p.pendingRebuy,
        lastAction: p.lastAction
      };
    });
  }

  private buildState(recipientPlayerId: string): TableStateDTO {
    const readyPlayerIds = this.activeSeatedPlayers()
      .filter((p) => p.ready)
      .map((p) => p.playerId);
    return {
      tableId: this.cfg.tableId,
      maxSeats: this.cfg.maxSeats,
      hostPlayerId: this.hostPlayerId,
      readyPlayerIds,
      canStartHand: this.canStartHand(),
      waitingForReady: !this.hand,
      waiting: this.waiting.map((id) => {
        const p = this.players.get(id)!;
        return { playerId: id, nickname: p.nickname, isConnected: p.isConnected };
      }),
      seats: this.buildSeatView(recipientPlayerId),
      hand: {
        handId: this.hand?.handId ?? null,
        buttonPos: this.buttonPos,
        smallBlind: this.cfg.sb,
        bigBlind: this.cfg.bb,
        board: this.hand?.board ?? [],
        street: this.hand?.street ?? "waiting",
        toActSeat: this.hand?.toActSeat ?? null,
        currentBet: this.hand?.currentBet ?? 0,
        minRaiseTo: this.hand?.minRaiseTo ?? this.cfg.bb,
        pots: this.hand?.pots ?? [],
        actionDeadlineTs: this.hand?.actionDeadlineTs ?? null,
        startedAt: this.hand?.startedAt ?? null,
        showdownAt: this.hand?.showdownAt ?? null
      },
      blindLevel: { sb: this.cfg.sb, bb: this.cfg.bb },
      buyIn: this.cfg.buyIn
    };
  }

  private buildPartial(recipientPlayerId: string): PartialGameStateDTO {
    const state = this.buildState(recipientPlayerId);
    return { hand: state.hand, seats: state.seats };
  }

  private broadcastAllStates(): void {
    for (const p of this.players.values()) {
      if (!p.socketId) {
        continue;
      }
      this.hooks.onTableState(p.playerId, this.buildState(p.playerId));
    }
  }

  private broadcastIncremental(): void {
    for (const p of this.players.values()) {
      if (!p.socketId) {
        continue;
      }
      this.hooks.onStateChanged(p.playerId, this.buildPartial(p.playerId));
    }
  }

  private broadcastActionEvent(event: ActionRecordDTO & { isAuto?: boolean }): void {
    for (const p of this.players.values()) {
      if (!p.socketId) {
        continue;
      }
      this.hooks.onActionEvent(p.playerId, event);
    }
  }

  private pushFullState(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p?.socketId) {
      return;
    }
    this.hooks.onTableState(playerId, this.buildState(playerId));
  }

  private pushNotice(playerId: string, type: "info" | "warn" | "error", message: string): void {
    const p = this.players.get(playerId);
    if (!p?.socketId) {
      return;
    }
    this.hooks.onNotice(playerId, { type, message });
  }

  private removeFromWaiting(playerId: string): void {
    const idx = this.waiting.indexOf(playerId);
    if (idx >= 0) {
      this.waiting.splice(idx, 1);
    }
  }

  private canStartHand(): boolean {
    if (this.hand) {
      return false;
    }
    const eligible = this.eligibleForHand();
    if (eligible.length < 2) {
      return false;
    }
    return eligible.every((p) => p.ready);
  }

  private ensureHost(): void {
    if (this.hostPlayerId && this.players.has(this.hostPlayerId)) {
      return;
    }
    const connected = [...this.players.values()].find((p) => p.isConnected);
    this.hostPlayerId = connected?.playerId ?? [...this.players.values()][0]?.playerId ?? null;
  }
}
