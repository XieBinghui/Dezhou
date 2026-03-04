import React from "react";
import ReactDOM from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import type {
  ActionRecordDTO,
  ActionType,
  Card,
  ClientToServerEvents,
  HandResultDTO,
  PartialGameStateDTO,
  ServerToClientEvents,
  SeatState,
  SystemNoticeDTO,
  TableStateDTO
} from "@dezhou/shared";
import "./styles.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? window.location.origin;
const LOCAL_TEST_MODE = new URLSearchParams(window.location.search).get("localtest") === "1";
const DEFAULT_BENCH_HANDS = 30;
const DEFAULT_BENCH_TIMEOUT_MS = 180_000;
const STALL_TIMEOUT_MS = 15_000;

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type BotClient = {
  socket: GameSocket;
  playerId: string;
  nickname: string;
  tableState: TableStateDTO | null;
  lastActionKey: string;
  pendingTimer: number | null;
};

type BenchState = {
  running: boolean;
  targetHands: number;
  completedHands: number;
  abnormalCount: number;
  avgHandMs: number;
  timeoutMs: number;
  status: string;
};

const SUIT_META: Record<string, { symbol: string; colorClass: "red" | "black" }> = {
  s: { symbol: "♠", colorClass: "black" },
  h: { symbol: "♥", colorClass: "red" },
  d: { symbol: "♦", colorClass: "red" },
  c: { symbol: "♣", colorClass: "black" }
};

function CardTile({ card, hidden = false, small = false }: { card?: Card | null; hidden?: boolean; small?: boolean }): JSX.Element {
  if (hidden || !card) {
    return <span className={`card-tile back ${small ? "small" : ""}`}>🂠</span>;
  }
  const suitMeta = SUIT_META[card.suit] ?? SUIT_META.s;
  return (
    <span className={`card-tile ${suitMeta.colorClass} ${small ? "small" : ""}`}>
      <span>{card.rank}</span>
      <span>{suitMeta.symbol}</span>
    </span>
  );
}

function formatStreet(street: string): string {
  switch (street) {
    case "preflop":
      return "翻前";
    case "flop":
      return "翻牌";
    case "turn":
      return "转牌";
    case "river":
      return "河牌";
    case "showdown":
      return "摊牌";
    default:
      return street;
  }
}

function formatActionShort(action: ActionType, amount: number): string {
  if (action === "check" || action === "fold") {
    return action.toUpperCase();
  }
  return `${action.toUpperCase()} ${amount}`;
}

function formatActionLog(event: ActionRecordDTO & { isAuto?: boolean }, blindLevel: { sb: number; bb: number }): string {
  const isBlindPost = event.action === "bet" && event.street === "preflop" && (event.amount === blindLevel.sb || event.amount === blindLevel.bb);
  const act = isBlindPost ? (event.amount === blindLevel.sb ? "SB盲注" : "BB盲注") : formatActionShort(event.action, event.amount);
  const autoSuffix = event.isAuto ? " AUTO" : "";
  return `[${formatStreet(event.street)}] ${event.nickname} ${act}${autoSuffix}`;
}

function formatSeatLastAction(action: SeatState["lastAction"]): string {
  if (!action) {
    return "";
  }
  const base = formatActionShort(action.action, action.amount);
  return action.isAuto ? `${base} AUTO` : base;
}

function pickBotAction(state: TableStateDTO, seat: TableStateDTO["seats"][number]): { action: ActionType; amount?: number } {
  const hand = state.hand;
  const bb = state.blindLevel.bb;
  const callNeed = Math.max(0, hand.currentBet - seat.committed);
  const maxStreetTotal = seat.committed + seat.stack;

  if (callNeed === 0) {
    if (seat.stack <= hand.minRaiseTo || Math.random() < 0.75) {
      return { action: "check" };
    }
    const target = Math.min(hand.minRaiseTo + (Math.random() < 0.4 ? 0 : bb * 2), maxStreetTotal);
    if (target <= seat.committed) {
      return { action: "check" };
    }
    if (target === maxStreetTotal) {
      return { action: "allin" };
    }
    return { action: "bet", amount: target };
  }

  if (callNeed >= seat.stack) {
    return Math.random() < 0.85 ? { action: "allin" } : { action: "fold" };
  }

  const r = Math.random();
  if (r < 0.1 && maxStreetTotal > hand.currentBet) {
    const target = Math.min(hand.minRaiseTo + (Math.random() < 0.5 ? 0 : bb * 2), maxStreetTotal);
    if (target > hand.currentBet) {
      if (target === maxStreetTotal) {
        return { action: "allin" };
      }
      return { action: "raise", amount: target };
    }
  }
  if (r < 0.78 || callNeed <= bb * 2) {
    return { action: "call" };
  }
  return { action: "fold" };
}

function App(): JSX.Element {
  const [socket, setSocket] = React.useState<GameSocket | null>(null);
  const [nickname, setNickname] = React.useState("");
  const [joined, setJoined] = React.useState(false);
  const [playerId, setPlayerId] = React.useState<string | null>(null);
  const [tableState, setTableState] = React.useState<TableStateDTO | null>(null);
  const [systemLogs, setSystemLogs] = React.useState<string[]>([]);
  const [actionLogs, setActionLogs] = React.useState<string[]>([]);
  const [showdownResult, setShowdownResult] = React.useState<HandResultDTO | null>(null);
  const [raiseTo, setRaiseTo] = React.useState<number>(0);
  const [botCount, setBotCount] = React.useState(0);
  const [bench, setBench] = React.useState<BenchState>({
    running: false,
    targetHands: DEFAULT_BENCH_HANDS,
    completedHands: 0,
    abnormalCount: 0,
    avgHandMs: 0,
    timeoutMs: DEFAULT_BENCH_TIMEOUT_MS,
    status: "待启动"
  });

  const botsRef = React.useRef<BotClient[]>([]);
  const showdownTimerRef = React.useRef<number | null>(null);
  const benchRef = React.useRef({
    running: false,
    startedAt: 0,
    deadlineAt: 0,
    lastProgressAt: 0,
    targetHands: DEFAULT_BENCH_HANDS,
    completedHands: 0,
    abnormalCount: 0,
    sumHandMs: 0,
    handStarts: new Map<string, number>()
  });
  const blindLevelRef = React.useRef<{ sb: number; bb: number }>({ sb: 1, bb: 2 });

  const bumpAbnormal = React.useCallback((reason: string) => {
    setBench((prev) => ({ ...prev, abnormalCount: prev.abnormalCount + 1, status: reason }));
    benchRef.current.abnormalCount += 1;
  }, []);

  const maybeActBot = React.useCallback(
    (bot: BotClient) => {
      const state = bot.tableState;
      if (!LOCAL_TEST_MODE || !state?.hand.handId || state.hand.toActSeat === null) {
        return;
      }
      const seat = state.seats.find((s) => s.playerId === bot.playerId);
      if (!seat || seat.seatIndex !== state.hand.toActSeat) {
        return;
      }

      const key = `${state.hand.handId}:${state.hand.street}:${state.hand.toActSeat}:${state.hand.currentBet}:${seat.committed}`;
      if (bot.lastActionKey === key) {
        return;
      }
      bot.lastActionKey = key;

      if (bot.pendingTimer !== null) {
        window.clearTimeout(bot.pendingTimer);
      }

      bot.pendingTimer = window.setTimeout(() => {
        const action = pickBotAction(state, seat);
        bot.socket.emit("game:action", { handId: state.hand.handId!, action: action.action, amount: action.amount }, (res) => {
          if (!res.ok) {
            bumpAbnormal(`测试玩家行动失败: ${res.reason ?? "unknown"}`);
          }
        });
      }, 250 + Math.floor(Math.random() * 700));
    },
    [bumpAbnormal]
  );

  React.useEffect(() => {
    const s = io(SERVER_URL);
    setSocket(s as GameSocket);

    s.on("table:state", (state) => {
      setTableState(state);
      blindLevelRef.current = state.blindLevel;
      setRaiseTo(Math.max(state.hand.minRaiseTo, state.hand.currentBet + state.blindLevel.bb));

      const handId = state.hand.handId;
      if (handId && state.hand.startedAt) {
        benchRef.current.handStarts.set(handId, state.hand.startedAt);
      }
    });

    s.on("game:stateChanged", (partial: PartialGameStateDTO) => {
      setTableState((prev) => {
        if (!prev) {
          return prev;
        }
        const next = { ...prev, hand: partial.hand, seats: partial.seats };
        if (next.hand.handId && next.hand.startedAt) {
          benchRef.current.handStarts.set(next.hand.handId, next.hand.startedAt);
        }
        return next;
      });
    });

    s.on("system:notice", (notice: SystemNoticeDTO) => {
      setSystemLogs((prev) => [`[${notice.type}] ${notice.message}`, ...prev].slice(0, 40));
    });

    s.on("game:handResult", (result: HandResultDTO) => {
      const winnerText = result.winners.map((w) => `${w.nickname}+${w.amount}(${w.handName})`).join(" | ");
      setSystemLogs((prev) => [`[结算] ${winnerText}`, ...prev].slice(0, 40));
      if (result.showdownPlayers.length > 0) {
        setShowdownResult(result);
        if (showdownTimerRef.current !== null) {
          window.clearTimeout(showdownTimerRef.current);
        }
        showdownTimerRef.current = window.setTimeout(() => {
          setShowdownResult(null);
          showdownTimerRef.current = null;
        }, 6_000);
      } else {
        setShowdownResult(null);
      }

      if (benchRef.current.running) {
        const startedAt = benchRef.current.handStarts.get(result.handId);
        const handMs = startedAt ? Date.now() - startedAt : 0;
        benchRef.current.completedHands += 1;
        benchRef.current.lastProgressAt = Date.now();
        benchRef.current.sumHandMs += handMs;
        const completed = benchRef.current.completedHands;
        const avg = completed > 0 ? Math.round(benchRef.current.sumHandMs / completed) : 0;

        setBench((prev) => ({
          ...prev,
          completedHands: completed,
          avgHandMs: avg,
          abnormalCount: benchRef.current.abnormalCount,
          status: `运行中：已完成 ${completed}/${benchRef.current.targetHands} 局`
        }));

        window.setTimeout(() => {
          void readyAllBots(true).then(() => {
            setReady(true);
            hostStartHand();
          });
        }, 400);
      }
    });

    s.on("game:actionEvent", (event) => {
      setActionLogs((prev) => [formatActionLog(event, blindLevelRef.current), ...prev].slice(0, 80));
    });

    return () => {
      if (showdownTimerRef.current !== null) {
        window.clearTimeout(showdownTimerRef.current);
      }
      s.disconnect();
    };
  }, []);

  const join = () => {
    if (!socket || !nickname.trim()) {
      return;
    }
    const token = LOCAL_TEST_MODE ? undefined : localStorage.getItem("dezhou_token") ?? undefined;
    socket.emit("player:join", { nickname: nickname.trim(), reconnectToken: token }, (res) => {
      if (!res.ok) {
        alert(res.reason ?? "加入失败");
        return;
      }
      if (res.token && !LOCAL_TEST_MODE) {
        localStorage.setItem("dezhou_token", res.token);
      }
      if (res.playerId) {
        setPlayerId(res.playerId);
      }
      setJoined(true);
    });
  };

  const setReady = React.useCallback(
    (ready: boolean) => {
      if (!socket) {
        return;
      }
      socket.emit("player:ready", { ready }, (res) => {
        if (!res.ok) {
          setSystemLogs((prev) => [`[error] ${res.reason ?? "准备状态更新失败"}`, ...prev].slice(0, 40));
        }
      });
    },
    [socket]
  );

  const hostStartHand = React.useCallback(() => {
    if (!socket) {
      return;
    }
    socket.emit("host:startHand", (res) => {
      if (!res.ok) {
        setSystemLogs((prev) => [`[error] ${res.reason ?? "开局失败"}`, ...prev].slice(0, 40));
      }
    });
  }, [socket]);

  const readyAllBots = React.useCallback(async (ready: boolean) => {
    await Promise.all(
      botsRef.current.map(
        (bot) =>
          new Promise<void>((resolve) => {
            bot.socket.emit("player:ready", { ready }, () => resolve());
          })
      )
    );
  }, []);

  const addBotAtSeat = React.useCallback(
    async (seatIndex: number): Promise<boolean> => {
      const botSocket = io(SERVER_URL) as GameSocket;
      const nicknameText = `测试${Math.floor(Math.random() * 100000)}`;
      const joinRes = await new Promise<{ ok: boolean; reason?: string; playerId?: string }>((resolve) => {
        botSocket.emit("player:join", { nickname: nicknameText }, (res) => resolve(res));
      });
      if (!joinRes.ok || !joinRes.playerId) {
        botSocket.disconnect();
        bumpAbnormal("测试玩家加入失败");
        return false;
      }

      const bot: BotClient = {
        socket: botSocket,
        playerId: joinRes.playerId,
        nickname: nicknameText,
        tableState: null,
        lastActionKey: "",
        pendingTimer: null
      };

      botSocket.on("table:state", (state) => {
        bot.tableState = state;
        maybeActBot(bot);
      });

      botSocket.on("game:stateChanged", (partial: PartialGameStateDTO) => {
        if (!bot.tableState) {
          return;
        }
        bot.tableState = { ...bot.tableState, hand: partial.hand, seats: partial.seats };
        maybeActBot(bot);
      });

      const sitRes = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        botSocket.emit("player:sit", { seatIndex }, (res) => resolve(res));
      });
      if (!sitRes.ok) {
        botSocket.disconnect();
        bumpAbnormal(`测试玩家入座失败: ${sitRes.reason ?? "unknown"}`);
        return false;
      }

      await new Promise<void>((resolve) => {
        botSocket.emit("player:ready", { ready: true }, () => resolve());
      });

      botsRef.current.push(bot);
      setBotCount(botsRef.current.length);
      return true;
    },
    [bumpAbnormal, maybeActBot]
  );

  const fillToTargetPlayers = React.useCallback(
    async (targetSeatedPlayers: number) => {
      if (!tableState) {
        return;
      }
      const seatedCount = tableState.seats.filter((s) => !!s.playerId).length;
      const need = Math.max(0, targetSeatedPlayers - seatedCount);
      const emptySeats = tableState.seats.filter((s) => !s.playerId).map((s) => s.seatIndex).slice(0, need);
      for (const seatIndex of emptySeats) {
        await addBotAtSeat(seatIndex);
      }
      if (LOCAL_TEST_MODE) {
        setReady(true);
        await readyAllBots(true);
        if (!tableState.hand.handId && tableState.hostPlayerId === playerId) {
          hostStartHand();
        }
      }
    },
    [addBotAtSeat, hostStartHand, playerId, readyAllBots, setReady, tableState]
  );

  const stopBenchRun = React.useCallback((status: string) => {
    benchRef.current.running = false;
    setBench((prev) => ({
      ...prev,
      running: false,
      completedHands: benchRef.current.completedHands,
      abnormalCount: benchRef.current.abnormalCount,
      avgHandMs:
        benchRef.current.completedHands > 0
          ? Math.round(benchRef.current.sumHandMs / benchRef.current.completedHands)
          : 0,
      status
    }));
  }, []);

  const clearBots = React.useCallback(async () => {
    stopBenchRun("已停止并清理测试玩家");
    const bots = [...botsRef.current];
    botsRef.current = [];
    setBotCount(0);
    await Promise.all(
      bots.map(
        (bot) =>
          new Promise<void>((resolve) => {
            if (bot.pendingTimer !== null) {
              window.clearTimeout(bot.pendingTimer);
            }
            bot.socket.emit("player:leaveSeat", () => {
              bot.socket.disconnect();
              resolve();
            });
          })
      )
    );
  }, [stopBenchRun]);

  const startBenchRun = React.useCallback(async () => {
    if (!tableState || benchRef.current.running) {
      return;
    }

    benchRef.current.running = true;
    benchRef.current.startedAt = Date.now();
    benchRef.current.deadlineAt = Date.now() + bench.timeoutMs;
    benchRef.current.lastProgressAt = Date.now();
    benchRef.current.completedHands = 0;
    benchRef.current.abnormalCount = 0;
    benchRef.current.sumHandMs = 0;
    benchRef.current.handStarts.clear();
    benchRef.current.targetHands = bench.targetHands;

    setBench((prev) => ({
      ...prev,
      running: true,
      completedHands: 0,
      abnormalCount: 0,
      avgHandMs: 0,
      status: `压测启动：目标 ${prev.targetHands} 局`
    }));

    await fillToTargetPlayers(10);
    setReady(true);
    await readyAllBots(true);
    hostStartHand();
  }, [bench.targetHands, bench.timeoutMs, fillToTargetPlayers, hostStartHand, readyAllBots, setReady, tableState]);

  React.useEffect(() => {
    return () => {
      for (const bot of botsRef.current) {
        if (bot.pendingTimer !== null) {
          window.clearTimeout(bot.pendingTimer);
        }
        bot.socket.disconnect();
      }
      botsRef.current = [];
      benchRef.current.running = false;
    };
  }, []);

  React.useEffect(() => {
    if (!LOCAL_TEST_MODE) {
      return;
    }
    const interval = window.setInterval(() => {
      if (!benchRef.current.running) {
        return;
      }
      const now = Date.now();

      if (benchRef.current.completedHands >= benchRef.current.targetHands) {
        stopBenchRun(`完成：${benchRef.current.completedHands} 局`);
        return;
      }

      if (now > benchRef.current.deadlineAt) {
        stopBenchRun(`超时终止：${Math.round((now - benchRef.current.startedAt) / 1000)} 秒`);
        return;
      }

      if (now - benchRef.current.lastProgressAt > STALL_TIMEOUT_MS) {
        benchRef.current.lastProgressAt = now;
        benchRef.current.abnormalCount += 1;
        setBench((prev) => ({ ...prev, abnormalCount: benchRef.current.abnormalCount, status: "检测到卡局，尝试补位恢复" }));
        void fillToTargetPlayers(10);
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [fillToTargetPlayers, stopBenchRun]);

  const mySeat = React.useMemo(() => {
    if (!tableState || !playerId) {
      return null;
    }
    return tableState.seats.find((s) => s.playerId === playerId) ?? null;
  }, [tableState, playerId]);

  const isMyTurn = Boolean(tableState && mySeat && tableState.hand.toActSeat === mySeat.seatIndex);

  const sendAction = (action: ActionType, amount?: number) => {
    if (!socket || !tableState?.hand.handId) {
      return;
    }
    socket.emit("game:action", { handId: tableState.hand.handId, action, amount }, (res) => {
      if (!res.ok) {
        setSystemLogs((prev) => [`[error] ${res.reason ?? "行动失败"}`, ...prev].slice(0, 40));
      }
    });
  };

  if (!joined) {
    return (
      <div className="join-page">
        <div className="join-card">
          <h1>单桌私用德州扑克</h1>
          <p>输入昵称直接进桌（10人上限）</p>
          {LOCAL_TEST_MODE ? <p className="hint">本机测试模式已开启（URL 包含 `?localtest=1`）</p> : null}
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="你的昵称" maxLength={20} />
          <button onClick={join}>进入牌桌</button>
        </div>
      </div>
    );
  }

  if (!tableState) {
    return <div className="join-page">正在同步牌桌状态...</div>;
  }

  const hand = tableState.hand;
  const callNeed = mySeat ? Math.max(0, hand.currentBet - mySeat.committed) : 0;
  const iAmHost = tableState.hostPlayerId === playerId;
  const myReady = !!mySeat?.isReady;
  const readyCount = tableState.readyPlayerIds.length;
  const seatedCount = tableState.seats.filter((s) => !!s.playerId).length;
  const hostName =
    tableState.seats.find((s) => s.playerId === tableState.hostPlayerId)?.nickname ??
    tableState.waiting.find((w) => w.playerId === tableState.hostPlayerId)?.nickname ??
    "-";

  return (
    <div className="page">
      <header className="topbar">
        <div>盲注: {tableState.blindLevel.sb}/{tableState.blindLevel.bb}</div>
        <div>买入: {tableState.buyIn}</div>
        <div>当前街: {hand.street}</div>
        <div>房主: {hostName}</div>
        <div>准备: {readyCount}/{seatedCount}</div>
      </header>

      <main className="layout">
        <section className="table">
          <div className="board">
            <h2>公共牌</h2>
            <div className="board-cards">
              <div className="cards">{hand.board.map((c, idx) => <CardTile key={`${c.rank}${c.suit}${idx}`} card={c} />)}</div>
            </div>
            <div className="board-stats">
              <div>当前下注: {hand.currentBet}</div>
              <div>最小加注到: {hand.minRaiseTo}</div>
            </div>
            <div className="board-turn">
              <div>行动位: {hand.toActSeat ?? "-"}</div>
            </div>
          </div>

          {showdownResult ? (
            <div className="showdown-panel">
              <div className="showdown-header">
                <h3>摊牌</h3>
                <button
                  onClick={() => {
                    if (showdownTimerRef.current !== null) {
                      window.clearTimeout(showdownTimerRef.current);
                      showdownTimerRef.current = null;
                    }
                    setShowdownResult(null);
                  }}
                >
                  关闭
                </button>
              </div>
              <div className="showdown-board">
                {showdownResult.board.map((c, idx) => <CardTile key={`sd-board-${c.rank}${c.suit}${idx}`} card={c} />)}
              </div>
              <div className="showdown-list">
                {showdownResult.showdownPlayers.map((p) => (
                  <div key={p.playerId} className={`showdown-item ${p.isWinner ? "winner" : ""}`}>
                    <div className="showdown-meta">
                      <span>{p.nickname}</span>
                      <span>{p.positionLabel ?? `座位${p.seatIndex + 1}`}</span>
                      <span>{p.handName}</span>
                      <span>{p.isWinner ? `+${p.winAmount}` : "未获胜"}</span>
                    </div>
                    <div className="showdown-cards">
                      <div className="seat-cards">
                        <CardTile card={p.holeCards[0]} small />
                        <CardTile card={p.holeCards[1]} small />
                      </div>
                      <div className="seat-cards">
                        {p.bestFive.map((c, idx) => <CardTile key={`best-${p.playerId}-${c.rank}${c.suit}${idx}`} card={c} small />)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="seats">
            {tableState.seats.map((seat) => (
              <button
                key={seat.seatIndex}
                className={`seat ${seat.playerId ? "occupied" : "empty"} ${hand.toActSeat === seat.seatIndex ? "active" : ""}`}
                disabled={!!seat.playerId || !playerId}
                onClick={() => socket?.emit("player:sit", { seatIndex: seat.seatIndex }, () => {})}
              >
                <div>#{seat.seatIndex + 1}</div>
                <div>{seat.nickname ?? "空位"}</div>
                <div>{seat.playerId ? `筹码 ${seat.stack}` : "点击就座"}</div>
                <div>{seat.isConnected ? "在线" : seat.playerId ? "离线" : ""}</div>
                <div>{seat.isHost ? "房主" : seat.isReady ? "已准备" : seat.playerId ? "未准备" : ""}</div>
                {seat.positionLabel ? <div className="seat-position">{seat.positionLabel}</div> : null}
                {seat.lastAction ? <div className="seat-last-action">{formatSeatLastAction(seat.lastAction)}</div> : null}
                {seat.isDealer ? <div>D</div> : null}
                {seat.holeCards ? (
                  <div className="seat-cards">
                    <CardTile card={seat.holeCards[0]} small />
                    <CardTile card={seat.holeCards[1]} small />
                  </div>
                ) : seat.inHand ? (
                  <div className="seat-cards">
                    <CardTile hidden small />
                    <CardTile hidden small />
                  </div>
                ) : null}
              </button>
            ))}
          </div>

          <div className="actions">
            <button disabled={!mySeat} onClick={() => socket?.emit("player:leaveSeat", () => {})}>离座</button>
            <button disabled={!mySeat || mySeat.stack > 0} onClick={() => socket?.emit("player:rebuy", () => {})}>补码</button>
            <button disabled={!mySeat || !!hand.handId} onClick={() => setReady(!myReady)}>{myReady ? "取消准备" : "准备"}</button>
            <button disabled={!iAmHost || !tableState.canStartHand || !!hand.handId} onClick={hostStartHand}>
              {hand.handId ? "进行中" : "开始本局"}
            </button>
            <button disabled={!isMyTurn} onClick={() => sendAction("fold")}>Fold</button>
            <button disabled={!isMyTurn || callNeed !== 0} onClick={() => sendAction("check")}>Check</button>
            <button disabled={!isMyTurn || callNeed === 0} onClick={() => sendAction("call")}>Call {callNeed}</button>
            <button disabled={!isMyTurn || hand.currentBet !== 0} onClick={() => sendAction("bet", raiseTo)}>Bet {raiseTo}</button>
            <button disabled={!isMyTurn || hand.currentBet === 0} onClick={() => sendAction("raise", raiseTo)}>Raise to {raiseTo}</button>
            <button disabled={!isMyTurn} onClick={() => sendAction("allin")}>All-in</button>
            <input type="number" value={raiseTo} min={hand.minRaiseTo} onChange={(e) => setRaiseTo(Number(e.target.value))} />
          </div>
        </section>

        <aside className="sidebar">
          {LOCAL_TEST_MODE ? (
            <>
              <h3>本机测试</h3>
              <div className="test-controls">
                <button onClick={() => void fillToTargetPlayers(6)}>补满到6人</button>
                <button onClick={() => void fillToTargetPlayers(10)}>补满到10人</button>
                <button onClick={() => void clearBots()}>清理测试玩家</button>
              </div>
              <div>测试玩家数: {botCount}</div>
              <h3>压测面板</h3>
              <div className="test-controls">
                <button disabled={bench.running} onClick={() => void startBenchRun()}>自动跑{bench.targetHands}局</button>
                <button disabled={!bench.running} onClick={() => stopBenchRun("手动停止")}>停止压测</button>
                <label>
                  局数
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={bench.targetHands}
                    disabled={bench.running}
                    onChange={(e) => setBench((prev) => ({ ...prev, targetHands: Math.max(1, Number(e.target.value) || 1) }))}
                  />
                </label>
                <label>
                  超时(秒)
                  <input
                    type="number"
                    min={30}
                    max={1800}
                    value={Math.floor(bench.timeoutMs / 1000)}
                    disabled={bench.running}
                    onChange={(e) =>
                      setBench((prev) => ({
                        ...prev,
                        timeoutMs: Math.max(30, Number(e.target.value) || 30) * 1000
                      }))
                    }
                  />
                </label>
              </div>
              <div>压测状态: {bench.status}</div>
              <div>完成局数: {bench.completedHands}/{bench.targetHands}</div>
              <div>平均每局: {bench.avgHandMs} ms</div>
              <div>异常次数: {bench.abnormalCount}</div>
            </>
          ) : null}
          <h3>等待区</h3>
          {tableState.waiting.map((w) => <div key={w.playerId}>{w.nickname} {w.isConnected ? "在线" : "离线"}</div>)}
          <h3>动作流</h3>
          <div className="logs">{actionLogs.map((log, idx) => <div key={`a-${idx}`}>{log}</div>)}</div>
          <h3>系统日志</h3>
          <div className="logs">{systemLogs.map((log, idx) => <div key={`s-${idx}`}>{log}</div>)}</div>
        </aside>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
