export type Street = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown" | "settlement";

export type PlayerStatus = "empty" | "seated" | "folded" | "allin" | "out";

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface Card {
  rank: "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
  suit: "s" | "h" | "d" | "c";
}

export interface SeatState {
  seatIndex: number;
  playerId: string | null;
  nickname: string | null;
  stack: number;
  committed: number;
  status: PlayerStatus;
  isConnected: boolean;
  isHost: boolean;
  isReady: boolean;
  positionLabel: string | null;
  isDealer: boolean;
  inHand: boolean;
  holeCards: [Card, Card] | null;
  pendingRebuy: boolean;
  lastAction: SeatLastActionDTO | null;
}

export interface PotDTO {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface HandStateDTO {
  handId: string | null;
  buttonPos: number;
  smallBlind: number;
  bigBlind: number;
  board: Card[];
  street: Street;
  toActSeat: number | null;
  currentBet: number;
  minRaiseTo: number;
  pots: PotDTO[];
  actionDeadlineTs: number | null;
  startedAt: number | null;
  showdownAt: number | null;
}

export interface ActionRecordDTO {
  handId: string;
  timestamp: number;
  playerId: string;
  nickname: string;
  street: Street;
  action: ActionType;
  amount: number;
}

export interface SeatLastActionDTO {
  action: ActionType;
  amount: number;
  street: Street;
  at: number;
  isAuto: boolean;
}

export interface HandResultWinnerDTO {
  playerId: string;
  nickname: string;
  amount: number;
  handName: string;
  cards: Card[];
}

export interface ShowdownPlayerDTO {
  playerId: string;
  nickname: string;
  seatIndex: number;
  positionLabel: string | null;
  holeCards: [Card, Card];
  bestFive: Card[];
  handName: string;
  isWinner: boolean;
  winAmount: number;
}

export interface HandResultDTO {
  handId: string;
  board: Card[];
  winners: HandResultWinnerDTO[];
  showdownPlayers: ShowdownPlayerDTO[];
  pots: PotDTO[];
  actionLog: ActionRecordDTO[];
}

export interface TableStateDTO {
  tableId: string;
  maxSeats: number;
  hostPlayerId: string | null;
  readyPlayerIds: string[];
  canStartHand: boolean;
  waitingForReady: boolean;
  waiting: Array<{ playerId: string; nickname: string; isConnected: boolean }>;
  seats: SeatState[];
  hand: HandStateDTO;
  blindLevel: { sb: number; bb: number };
  buyIn: number;
}

export interface PartialGameStateDTO {
  hand: HandStateDTO;
  seats: SeatState[];
}

export interface SystemNoticeDTO {
  type: "info" | "warn" | "error";
  message: string;
}

export interface ClientToServerEvents {
  "player:join": (payload: { nickname: string; reconnectToken?: string }, ack: (res: { ok: boolean; token?: string; playerId?: string; reason?: string }) => void) => void;
  "player:sit": (payload: { seatIndex: number }, ack: (res: { ok: boolean; reason?: string }) => void) => void;
  "player:leaveSeat": (ack: (res: { ok: boolean; reason?: string }) => void) => void;
  "game:action": (
    payload: { handId: string; action: ActionType; amount?: number },
    ack: (res: { ok: boolean; reason?: string }) => void
  ) => void;
  "player:rebuy": (ack: (res: { ok: boolean; reason?: string }) => void) => void;
  "player:ready": (payload: { ready: boolean }, ack: (res: { ok: boolean; reason?: string }) => void) => void;
  "host:startHand": (ack: (res: { ok: boolean; reason?: string }) => void) => void;
  "host:startNextHand": (ack: (res: { ok: boolean; reason?: string }) => void) => void;
}

export interface ServerToClientEvents {
  "table:state": (state: TableStateDTO) => void;
  "game:stateChanged": (partial: PartialGameStateDTO) => void;
  "game:actionEvent": (event: ActionRecordDTO & { isAuto?: boolean }) => void;
  "game:actionAck": (res: { ok: boolean; reason?: string }) => void;
  "game:handResult": (result: HandResultDTO) => void;
  "system:notice": (notice: SystemNoticeDTO) => void;
}
