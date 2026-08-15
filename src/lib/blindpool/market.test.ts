// Property tests for the public market model (plan §6.2).
//
// These target the invariants a prediction market cannot violate without being wrong in
// a way users would notice: odds that don't sum to 1, settlement that mints value, a
// winner who loses stake. Everything here is pure, so it runs headlessly in CI.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isAcceptingPositions,
  odds,
  oddsFor,
  otherSide,
  payout,
  totalVolume,
  type MarketState,
  type Side,
} from "./market";

/** Volumes up to ~2^128 — the range a felt-denominated token realistically reaches. */
const volume = fc.bigInt({ min: 0n, max: 2n ** 128n });

const sideArb: fc.Arbitrary<Side> = fc.constantFrom("YES", "NO");

function market(yes: bigint, no: bigint, over: Partial<MarketState> = {}): MarketState {
  return {
    id: "m1",
    question: "Will it?",
    resolutionSource: "https://example.org",
    deadline: 1_000_000,
    status: "OPEN",
    volume: { YES: yes, NO: no },
    ...over,
  };
}

describe("odds", () => {
  it("both sides always sum to exactly 1", () => {
    fc.assert(
      fc.property(volume, volume, (yes, no) => {
        const o = odds(market(yes, no));
        expect(o.YES + o.NO).toBe(1);
      }),
    );
  });

  it("is always a probability in [0, 1]", () => {
    fc.assert(
      fc.property(volume, volume, sideArb, (yes, no, side) => {
        const p = oddsFor(market(yes, no), side);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("an empty market is an honest 50/50 and never divides by zero", () => {
    const o = odds(market(0n, 0n));
    expect(o.YES).toBe(0.5);
    expect(o.NO).toBe(0.5);
  });

  it("is monotonic — adding volume to a side never lowers its odds", () => {
    fc.assert(
      fc.property(volume, volume, volume, (yes, no, add) => {
        const before = oddsFor(market(yes, no), "YES");
        const after = oddsFor(market(yes + add, no), "YES");
        expect(after).toBeGreaterThanOrEqual(before);
      }),
    );
  });

  it("does not lose precision on large bigint volumes", () => {
    // Whole-token volumes at 18 decimals: naive Number() conversion would collapse these.
    const big = 10n ** 30n;
    expect(oddsFor(market(big, big), "YES")).toBe(0.5);
    expect(oddsFor(market(big * 3n, big), "YES")).toBe(0.75);
  });
});

describe("payout", () => {
  const resolved = (yes: bigint, no: bigint, outcome: Side) =>
    market(yes, no, { status: "RESOLVED", outcome });

  it("a winner never receives less than their stake", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2n ** 64n }),
        volume,
        sideArb,
        (stake, losing, outcome) => {
          const state = resolved(
            outcome === "YES" ? stake : losing,
            outcome === "YES" ? losing : stake,
            outcome,
          );
          expect(payout(state, stake)).toBeGreaterThanOrEqual(stake);
        },
      ),
    );
  });

  it("is monotonic in stake", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2n ** 64n }),
        fc.bigInt({ min: 0n, max: 2n ** 64n }),
        fc.bigInt({ min: 1n, max: 2n ** 64n }),
        (a, extra, losing) => {
          const winning = a + extra + 1n;
          const state = resolved(winning, losing, "YES");
          expect(payout(state, a + extra)).toBeGreaterThanOrEqual(payout(state, a));
        },
      ),
    );
  });

  it("conserves value — total paid out never exceeds the pool", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 2n ** 40n }), { minLength: 1, maxLength: 20 }),
        fc.bigInt({ min: 0n, max: 2n ** 40n }),
        sideArb,
        (stakes, losing, outcome) => {
          const winning = stakes.reduce((a, b) => a + b, 0n);
          const state = resolved(
            outcome === "YES" ? winning : losing,
            outcome === "YES" ? losing : winning,
            outcome,
          );
          const paid = stakes.reduce((acc, s) => acc + payout(state, s), 0n);
          // Floor division on each share means the house never pays more than it holds.
          expect(paid).toBeLessThanOrEqual(totalVolume(state));
        },
      ),
    );
  });

  it("refuses to pay out an unresolved market", () => {
    expect(() => payout(market(1n, 1n), 1n)).toThrow(/not resolved/);
    expect(() => payout(market(1n, 1n, { status: "CLOSED" }), 1n)).toThrow(/not resolved/);
  });

  it("pays nothing when the winning side holds no volume", () => {
    expect(payout(resolved(0n, 5n, "YES"), 0n)).toBe(0n);
  });
});

describe("lifecycle", () => {
  it("accepts positions only while open and before the deadline", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), (now) => {
        const state = market(0n, 0n, { deadline: 1_000_000 });
        expect(isAcceptingPositions(state, now)).toBe(now < 1_000_000);
      }),
    );
  });

  it("never accepts positions once closed or resolved, whatever the clock says", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.constantFrom("CLOSED" as const, "RESOLVED" as const),
        (now, status) => {
          expect(isAcceptingPositions(market(0n, 0n, { status }), now)).toBe(false);
        },
      ),
    );
  });

  it("otherSide is an involution", () => {
    fc.assert(
      fc.property(sideArb, (s) => {
        expect(otherSide(otherSide(s))).toBe(s);
      }),
    );
  });
});
