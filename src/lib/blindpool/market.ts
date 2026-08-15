// Blindpool market model.
//
// The split this file encodes is the whole point of the project: everything in
// `MarketState` is public and on-chain, and everything about an individual
// position is not represented here at all — positions live as encrypted notes in
// the STRK20 pool and are only ever reachable with the holder's viewing key.
//
// If a field would let an observer attribute volume to a person, it does not
// belong in this file.

export type Side = "YES" | "NO";

export type MarketStatus = "OPEN" | "CLOSED" | "RESOLVED";

/**
 * Public market state. Safe to publish, index and serve to anyone.
 *
 * Note what is absent: no participant list, no per-position amounts, no
 * addresses. Aggregate volume per side is public because it is what produces the
 * odds; it is the coarsest signal that still makes the market useful.
 */
export interface MarketState {
  id: string;
  /** The claim being priced, e.g. "Will X ship before 1 Oct 2026?" */
  question: string;
  /** How the market resolves — declared up front, not chosen after the fact. */
  resolutionSource: string;
  /** Unix seconds. No position may be taken after this. */
  deadline: number;
  status: MarketStatus;
  /** Aggregate shielded volume per side, in token base units. */
  volume: Record<Side, bigint>;
  /** Set once status is RESOLVED. */
  outcome?: Side;
}

/**
 * Odds for a side, as a probability in [0, 1].
 *
 * Derived purely from aggregate volume, so it is computable by anyone from
 * public state. An empty market is an honest 50/50 rather than a divide by zero.
 */
export function oddsFor(state: MarketState, side: Side): number {
  const total = state.volume.YES + state.volume.NO;
  if (total === 0n) return 0.5;
  // Scale to integer basis points before converting, so we never lose precision
  // to floating point on large bigint volumes.
  const bps = (state.volume[side] * 10_000n) / total;
  return Number(bps) / 10_000;
}

/** Both sides at once, for rendering a book. */
export function odds(state: MarketState): Record<Side, number> {
  return { YES: oddsFor(state, "YES"), NO: oddsFor(state, "NO") };
}

/** Total shielded volume across both sides. */
export function totalVolume(state: MarketState): bigint {
  return state.volume.YES + state.volume.NO;
}

/** A market accepts positions only while open and before its deadline. */
export function isAcceptingPositions(state: MarketState, now: number): boolean {
  return state.status === "OPEN" && now < state.deadline;
}

export const otherSide = (side: Side): Side => (side === "YES" ? "NO" : "YES");

/**
 * Payout for a winning position of `amount`, under parimutuel settlement: the
 * losing side's volume is distributed across the winning side pro rata.
 *
 * This is a pure function of public aggregates plus the claimant's own private
 * amount, which is what lets settlement be proved without revealing the position
 * set it paid out to.
 */
export function payout(state: MarketState, amount: bigint): bigint {
  if (state.status !== "RESOLVED" || !state.outcome) {
    throw new Error(`Market ${state.id} is not resolved`);
  }
  const winning = state.volume[state.outcome];
  if (winning === 0n) return 0n;
  const losing = state.volume[otherSide(state.outcome)];
  // stake back + pro-rata share of the losing pool
  return amount + (amount * losing) / winning;
}
