// Property tests for the sealed-epoch mechanism (plan §6.2).
//
// RevealBinding from the TLA+ spec (§6.1) has its executable counterpart here: a reveal
// must hash back to its commitment, and no other (side, nonce, secret) may. If that fails,
// a bettor could switch sides after seeing the aggregate, which destroys the mechanism.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assessAnonymity,
  commitmentMatches,
  computeCommitment,
  createBetSecret,
  epochAt,
  epochClosesAt,
  epochPhase,
  isValidTranche,
  MIN_SAFE_ANONYMITY_SET,
  revealClosesAt,
  secondsRemaining,
  SIDE_FELT,
  TRANCHES,
  type BetSecret,
  type EpochSchedule,
  type ObservedCommit,
} from "./epoch";
import type { Side } from "./market";

const sideArb: fc.Arbitrary<Side> = fc.constantFrom("YES", "NO");
const feltArb = fc.bigInt({ min: 0n, max: 2n ** 200n });
const betArb: fc.Arbitrary<BetSecret> = fc.record({
  side: sideArb,
  nonce: feltArb,
  secret: feltArb,
});

const schedule: EpochSchedule = {
  startedAt: 1_000_000,
  durationSeconds: 3600,
  revealWindowSeconds: 900,
};

describe("commitment", () => {
  it("is deterministic", () => {
    fc.assert(
      fc.property(betArb, (bet) => {
        expect(computeCommitment(bet)).toBe(computeCommitment(bet));
      }),
    );
  });

  it("binds the reveal — a correct opening always verifies", () => {
    fc.assert(
      fc.property(betArb, (bet) => {
        expect(commitmentMatches(computeCommitment(bet), bet)).toBe(true);
      }),
    );
  });

  it("cannot be opened to the other side", () => {
    // The core anti-cheat property: having committed, a bettor cannot switch after seeing
    // the epoch aggregate.
    fc.assert(
      fc.property(betArb, (bet) => {
        const flipped: BetSecret = {
          ...bet,
          side: bet.side === "YES" ? "NO" : "YES",
        };
        expect(commitmentMatches(computeCommitment(bet), flipped)).toBe(false);
      }),
    );
  });

  it("cannot be opened with a different nonce or secret", () => {
    fc.assert(
      fc.property(betArb, feltArb, (bet, other) => {
        fc.pre(other !== bet.nonce && other !== bet.secret);
        expect(commitmentMatches(computeCommitment(bet), { ...bet, nonce: other })).toBe(false);
        expect(commitmentMatches(computeCommitment(bet), { ...bet, secret: other })).toBe(false);
      }),
    );
  });

  it("distinguishes sides that differ only by side", () => {
    fc.assert(
      fc.property(feltArb, feltArb, (nonce, secret) => {
        const yes = computeCommitment({ side: "YES", nonce, secret });
        const no = computeCommitment({ side: "NO", nonce, secret });
        expect(yes).not.toBe(no);
      }),
    );
  });

  it("never encodes a side as the zero felt", () => {
    // A zero field element must not be a valid side — it is the default value an
    // uninitialised Cairo storage slot would return.
    expect(SIDE_FELT.YES).not.toBe(0n);
    expect(SIDE_FELT.NO).not.toBe(0n);
  });

  it("does not match a malformed commitment string", () => {
    const bet = { side: "YES" as Side, nonce: 1n, secret: 2n };
    expect(commitmentMatches("not-a-felt", bet)).toBe(false);
    expect(commitmentMatches("", bet)).toBe(false);
  });

  it("generates distinct secrets across calls", () => {
    const a = createBetSecret("YES");
    const b = createBetSecret("YES");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.secret).not.toBe(b.secret);
    expect(computeCommitment(a)).not.toBe(computeCommitment(b));
  });
});

describe("tranches", () => {
  it("accepts only the fixed denominations", () => {
    for (const t of TRANCHES) expect(isValidTranche(t)).toBe(true);
  });

  it("rejects everything else — arbitrary amounts would fingerprint the bettor", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 80n }), (amount) => {
        fc.pre(!TRANCHES.includes(amount));
        expect(isValidTranche(amount)).toBe(false);
      }),
    );
  });
});

describe("epoch scheduling", () => {
  it("epochAt is monotonic in time and never negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.nat({ max: 100_000 }), (now, d) => {
        const a = epochAt(schedule, now);
        const b = epochAt(schedule, now + d);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThanOrEqual(a);
      }),
    );
  });

  it("clamps times before the market opened to epoch 0", () => {
    expect(epochAt(schedule, 0)).toBe(0);
    expect(epochAt(schedule, schedule.startedAt - 1)).toBe(0);
    expect(epochAt(schedule, schedule.startedAt)).toBe(0);
  });

  it("advances exactly one epoch per duration", () => {
    expect(epochAt(schedule, schedule.startedAt + 3599)).toBe(0);
    expect(epochAt(schedule, schedule.startedAt + 3600)).toBe(1);
    expect(epochAt(schedule, schedule.startedAt + 7200)).toBe(2);
  });

  it("phases are ordered COMMIT → REVEAL → SETTLED and never overlap", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), fc.integer({ min: 0, max: 5_000_000 }), (epoch, now) => {
        const phase = epochPhase(schedule, epoch, now);
        const close = epochClosesAt(schedule, epoch);
        const reveal = revealClosesAt(schedule, epoch);
        if (phase === "COMMIT") expect(now).toBeLessThan(close);
        else if (phase === "REVEAL") {
          expect(now).toBeGreaterThanOrEqual(close);
          expect(now).toBeLessThan(reveal);
        } else expect(now).toBeGreaterThanOrEqual(reveal);
      }),
    );
  });

  it("the reveal window opens exactly when commits close", () => {
    const close = epochClosesAt(schedule, 3);
    expect(epochPhase(schedule, 3, close - 1)).toBe("COMMIT");
    expect(epochPhase(schedule, 3, close)).toBe("REVEAL");
    expect(epochPhase(schedule, 3, revealClosesAt(schedule, 3))).toBe("SETTLED");
  });

  it("secondsRemaining is never negative and is zero once settled", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), fc.integer({ min: 0, max: 5_000_000 }), (epoch, now) => {
        const left = secondsRemaining(schedule, epoch, now);
        expect(left).toBeGreaterThanOrEqual(0);
        if (epochPhase(schedule, epoch, now) === "SETTLED") expect(left).toBe(0);
      }),
    );
  });
});

describe("anonymity set", () => {
  const commits = (epoch: number, denom: bigint, n: number): ObservedCommit[] =>
    Array.from({ length: n }, () => ({ epoch, denomination: denom }));

  it("counts the prospective bet itself", () => {
    expect(assessAnonymity([], 0, TRANCHES[0]).k).toBe(1);
  });

  it("counts only same-epoch, same-denomination commits", () => {
    const observed = [
      ...commits(0, TRANCHES[0], 3),
      ...commits(1, TRANCHES[0], 9), // different epoch
      ...commits(0, TRANCHES[1], 9), // different denomination
    ];
    expect(assessAnonymity(observed, 0, TRANCHES[0]).k).toBe(4);
  });

  it("flags sets below the safety threshold", () => {
    fc.assert(
      fc.property(fc.nat({ max: 30 }), (n) => {
        const a = assessAnonymity(commits(0, TRANCHES[0], n), 0, TRANCHES[0]);
        expect(a.safe).toBe(n + 1 >= MIN_SAFE_ANONYMITY_SET);
      }),
    );
  });

  it("always states the actual number, so the user can judge it", () => {
    fc.assert(
      fc.property(fc.nat({ max: 30 }), (n) => {
        const a = assessAnonymity(commits(0, TRANCHES[0], n), 0, TRANCHES[0]);
        expect(a.message).toContain(String(a.k));
      }),
    );
  });
});
