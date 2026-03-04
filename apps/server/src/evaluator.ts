import type { Card } from "@dezhou/shared";
import { rankToValue } from "./cards.js";

interface HandScore {
  category: number;
  tiebreakers: number[];
  name: string;
  bestFive: Card[];
}

const CATEGORY_NAME: Record<number, string> = {
  8: "同花顺",
  7: "四条",
  6: "葫芦",
  5: "同花",
  4: "顺子",
  3: "三条",
  2: "两对",
  1: "一对",
  0: "高牌"
};

function compareTiebreakers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

export function compareHandScore(a: HandScore, b: HandScore): number {
  if (a.category !== b.category) {
    return a.category - b.category;
  }
  return compareTiebreakers(a.tiebreakers, b.tiebreakers);
}

function straightHigh(ranks: number[]): number | null {
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  if (uniq.includes(14)) {
    uniq.push(1);
  }
  let run = 1;
  for (let i = 0; i < uniq.length - 1; i += 1) {
    if (uniq[i] - 1 === uniq[i + 1]) {
      run += 1;
      if (run >= 5) {
        return uniq[i - 3];
      }
    } else {
      run = 1;
    }
  }
  return null;
}

function evaluateFive(cards: Card[]): Omit<HandScore, "bestFive"> {
  const ranks = cards.map((c) => rankToValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const counts = new Map<number, number>();
  for (const r of ranks) {
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }

  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return b[0] - a[0];
  });

  const isFlush = suits.every((s) => s === suits[0]);
  const sHigh = straightHigh(ranks);

  if (isFlush && sHigh) {
    return { category: 8, tiebreakers: [sHigh], name: CATEGORY_NAME[8] };
  }

  if (groups[0][1] === 4) {
    const quad = groups[0][0];
    const kicker = groups[1][0];
    return { category: 7, tiebreakers: [quad, kicker], name: CATEGORY_NAME[7] };
  }

  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return { category: 6, tiebreakers: [groups[0][0], groups[1][0]], name: CATEGORY_NAME[6] };
  }

  if (isFlush) {
    return { category: 5, tiebreakers: [...ranks], name: CATEGORY_NAME[5] };
  }

  if (sHigh) {
    return { category: 4, tiebreakers: [sHigh], name: CATEGORY_NAME[4] };
  }

  if (groups[0][1] === 3) {
    const trips = groups[0][0];
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return { category: 3, tiebreakers: [trips, ...kickers], name: CATEGORY_NAME[3] };
  }

  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairHigh = Math.max(groups[0][0], groups[1][0]);
    const pairLow = Math.min(groups[0][0], groups[1][0]);
    const kicker = groups[2][0];
    return { category: 2, tiebreakers: [pairHigh, pairLow, kicker], name: CATEGORY_NAME[2] };
  }

  if (groups[0][1] === 2) {
    const pair = groups[0][0];
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return { category: 1, tiebreakers: [pair, ...kickers], name: CATEGORY_NAME[1] };
  }

  return { category: 0, tiebreakers: [...ranks], name: CATEGORY_NAME[0] };
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const path: T[] = [];
  function dfs(start: number): void {
    if (path.length === k) {
      out.push([...path]);
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      path.push(arr[i]);
      dfs(i + 1);
      path.pop();
    }
  }
  dfs(0);
  return out;
}

export function evaluateSeven(cards: Card[]): HandScore {
  if (cards.length !== 7) {
    throw new Error("evaluateSeven expects 7 cards");
  }
  let best: HandScore | null = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluateFive(combo);
    const candidate: HandScore = { ...score, bestFive: combo };
    if (!best || compareHandScore(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best!;
}
