import { describe, expect, it } from "vitest";
import type { Card } from "@dezhou/shared";
import { evaluateSeven, compareHandScore } from "./evaluator.js";

const c = (s: string): Card => ({ rank: s[0] as Card["rank"], suit: s[1] as Card["suit"] });

describe("evaluator", () => {
  it("identifies straight flush over full house", () => {
    const sf = evaluateSeven([c("As"), c("Ks"), c("Qs"), c("Js"), c("Ts"), c("2d"), c("3c")]);
    const fh = evaluateSeven([c("Ah"), c("Ad"), c("Ac"), c("Ks"), c("Kd"), c("2c"), c("3h")]);
    expect(compareHandScore(sf, fh)).toBeGreaterThan(0);
  });

  it("handles wheel straight", () => {
    const wheel = evaluateSeven([c("As"), c("2h"), c("3d"), c("4c"), c("5s"), c("Kh"), c("Qd")]);
    const highCard = evaluateSeven([c("As"), c("Kh"), c("Qd"), c("8c"), c("7s"), c("4h"), c("2d")]);
    expect(compareHandScore(wheel, highCard)).toBeGreaterThan(0);
  });
});
