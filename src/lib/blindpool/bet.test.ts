// Tests for transaction composition.
//
// The composition cannot be verified on-chain until the anonymizer exists, so these assert
// the things that fail *silently* at signing time: a hex-normalized placeholder, a stake
// sent to the wrong recipient, or a bet that requests an open note nobody fills.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildBetActions,
  buildClaimActions,
  buildRevealActions,
  openNotePlaceholder,
  OP,
  POOL_ADDRESS_PLACEHOLDER,
} from "./bet";
import { computeCommitment, TRANCHES, type BetSecret } from "./epoch";
import type { Side } from "./market";

const ANONYMIZER = "0x1234";
const TOKEN = "0xabcd";
const USER = "0xbeef";

const secret: BetSecret = { side: "YES", nonce: 7n, secret: 9n };
const bet = (over: Partial<Parameters<typeof buildBetActions>[0]> = {}) =>
  buildBetActions({
    anonymizer: ANONYMIZER,
    token: TOKEN,
    marketId: 1,
    epoch: 0,
    tranche: TRANCHES[0],
    secret,
    ...over,
  });

describe("placeholders", () => {
  it("are literal strings, never hex", () => {
    // The failure this guards: num.toHex("${poolAddress}") yields a valid-looking felt the
    // wallet does not recognize, so substitution silently never happens.
    expect(POOL_ADDRESS_PLACEHOLDER).toBe("${poolAddress}");
    expect(openNotePlaceholder(0)).toBe("${openNoteIds[0]}");
    expect(openNotePlaceholder(2)).toBe("${openNoteIds[2]}");
  });

  it("survive into the built calldata unmodified", () => {
    const invoke = bet()[1] as { calldata: string[] };
    expect(invoke.calldata).toContain("${poolAddress}");
    expect(invoke.calldata.some((c) => c.startsWith("0x") && c.includes("pool"))).toBe(false);
  });

  it("the claim open-note placeholder reaches the calldata intact", () => {
    const actions = buildClaimActions({
      anonymizer: ANONYMIZER,
      token: TOKEN,
      marketId: 1,
      recipient: USER,
      secret,
    });
    const invoke = actions[1] as { calldata: string[] };
    expect(invoke.calldata).toContain("${openNoteIds[0]}");
    expect(invoke.calldata).toContain("${poolAddress}");
  });
});

describe("buildBetActions", () => {
  it("withdraws the stake to the anonymizer, then invokes it", () => {
    const actions = bet();
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "withdraw", recipient: ANONYMIZER, token: TOKEN });
    expect(actions[1]).toMatchObject({ type: "invoke", contract: ANONYMIZER });
  });

  it("requests no open note — a bet has no output to receive", () => {
    // Requesting one would create a note the anonymizer has nothing to fill, and the
    // transaction would fail the pool's balance invariant.
    expect(bet().some((a) => a.type === "transfer")).toBe(false);
  });

  it("carries the commitment, never the side in the clear", () => {
    // Asserted as an exact layout rather than "does not contain the side felt": small
    // market ids and epochs hex-encode to the same short values as SIDE_FELT, so a
    // containment check would be a false positive on marketId 1. The layout is the real
    // guarantee — there is no slot for the side.
    const marketId = 42;
    const invoke = bet({ marketId })[1] as { calldata: string[] };
    expect(invoke.calldata).toEqual([
      OP.BET,
      "0x2a",
      "0x0",
      computeCommitment(secret),
      "0x8ac7230489e80000", // 10 STRK
      POOL_ADDRESS_PLACEHOLDER,
    ]);
  });

  it("produces identical calldata for YES and NO apart from the commitment", () => {
    // The indistinguishability property, asserted directly: an observer comparing two
    // bets of the same tranche sees one differing field, and it is a hash.
    const y = bet({ secret: { side: "YES", nonce: 7n, secret: 9n } })[1] as {
      calldata: string[];
    };
    const n = bet({ secret: { side: "NO", nonce: 7n, secret: 9n } })[1] as {
      calldata: string[];
    };
    expect(y.calldata).toHaveLength(n.calldata.length);
    const differing = y.calldata.filter((v, i) => v !== n.calldata[i]);
    expect(differing).toHaveLength(1);
    expect(differing[0]).toBe(computeCommitment({ side: "YES", nonce: 7n, secret: 9n }));
  });

  it("rejects any amount outside the tranche set", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2n ** 70n }), (amount) => {
        fc.pre(!TRANCHES.includes(amount));
        expect(() => bet({ tranche: amount })).toThrow(/not an allowed tranche/);
      }),
    );
  });

  it("accepts every allowed tranche", () => {
    for (const t of TRANCHES) expect(() => bet({ tranche: t })).not.toThrow();
  });

  it("produces a different commitment for every secret", () => {
    const sides: Side[] = ["YES", "NO"];
    const seen = new Set<string>();
    for (const side of sides) {
      for (let n = 1n; n <= 5n; n++) {
        const invoke = bet({ secret: { side, nonce: n, secret: n * 3n } })[1] as {
          calldata: string[];
        };
        seen.add(invoke.calldata[3]);
      }
    }
    expect(seen.size).toBe(10);
  });
});

describe("buildRevealActions", () => {
  it("moves no value — it is a pure state transition", () => {
    const actions = buildRevealActions({ anonymizer: ANONYMIZER, marketId: 1, secret });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("invoke");
  });

  it("sends the full opening so the contract can verify the commitment", () => {
    const invoke = buildRevealActions({ anonymizer: ANONYMIZER, marketId: 1, secret })[0] as {
      calldata: string[];
    };
    expect(invoke.calldata[0]).toBe(OP.REVEAL);
    expect(invoke.calldata).toContain(computeCommitment(secret));
    expect(invoke.calldata).toContain("0x7"); // nonce
    expect(invoke.calldata).toContain("0x9"); // secret
  });
});

describe("buildClaimActions", () => {
  it("credits the open note to the user, not the pool", () => {
    // Sending it to the pool address would strand the payout.
    const actions = buildClaimActions({
      anonymizer: ANONYMIZER,
      token: TOKEN,
      marketId: 1,
      recipient: USER,
      secret,
    });
    expect(actions[0]).toMatchObject({ type: "transfer", amount: "OPEN", recipient: USER });
  });

  it("does not bundle an unshield", () => {
    // Bundling would publish a withdrawal beside the claim that produced it and hand an
    // observer the correlation the mechanism exists to deny.
    const actions = buildClaimActions({
      anonymizer: ANONYMIZER,
      token: TOKEN,
      marketId: 1,
      recipient: USER,
      secret,
    });
    expect(actions.some((a) => a.type === "withdraw")).toBe(false);
  });
});
