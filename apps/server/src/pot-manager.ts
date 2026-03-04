export interface Contribution {
  playerId: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
}

export function buildPots(contributions: Contribution[]): Pot[] {
  const active = contributions.filter((c) => c.amount > 0);
  if (active.length === 0) {
    return [];
  }

  const levels = [...new Set(active.map((c) => c.amount))].sort((a, b) => a - b);
  let previous = 0;
  const pots: Pot[] = [];

  for (const level of levels) {
    const participants = active.filter((c) => c.amount >= level);
    const delta = level - previous;
    const amount = delta * participants.length;
    const eligiblePlayerIds = participants.filter((c) => !c.folded).map((c) => c.playerId);
    if (amount > 0 && eligiblePlayerIds.length > 0) {
      pots.push({ amount, eligiblePlayerIds });
    }
    previous = level;
  }

  return pots;
}
