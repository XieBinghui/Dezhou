import { describe, expect, it } from "vitest";
import { buildPots } from "./pot-manager.js";

describe("pot manager", () => {
  it("builds side pots correctly", () => {
    const pots = buildPots([
      { playerId: "A", amount: 100, folded: false },
      { playerId: "B", amount: 300, folded: false },
      { playerId: "C", amount: 300, folded: false },
      { playerId: "D", amount: 500, folded: true }
    ]);

    expect(pots).toEqual([
      { amount: 400, eligiblePlayerIds: ["A", "B", "C"] },
      { amount: 600, eligiblePlayerIds: ["B", "C"] },
      { amount: 200, eligiblePlayerIds: [] }
    ].filter((p) => p.eligiblePlayerIds.length > 0));
  });
});
