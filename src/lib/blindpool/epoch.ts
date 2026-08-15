// Sealed-epoch commitment mechanism.
//
// This is the module that makes Blindpool's privacy claim true rather than decorative.
// An anonymizer hides the bettor's address but not the value, so hiding *side* and
// *running odds* has to be bought by the mechanism:
//
//   1. During an epoch a bet publishes only H(side, nonce, secret) and a fixed tranche.
//      Two commits of the same denomination are indistinguishable on-chain.
//   2. Running odds are therefore not computable mid-epoch, which makes front-running
//      structurally impossible rather than merely difficult.
//   3. At epoch close, holders reveal and only per-side aggregates become public.
//
// The commitment is also what removes the need for shadow accounts: the position is a
// hash the user holds off-chain, so no persistent on-chain identity has to exist between
// placing a bet and claiming it.

import { hash, num } from "starknet";
import type { Side } from "./market";

/** Side encoded as a felt for hashing. Never 0 — a zero field must not be a valid side. */
export const SIDE_FELT: Record<Side, bigint> = { YES: 1n, NO: 2n };

const DECIMALS = 10n ** 18n;

/**
 * The only bet sizes Blindpool accepts.
 *
 * Fixed tranches are the entire size-privacy story: a bet is indistinguishable from every
 * other bet of the same denomination in the same epoch, and nothing more. Allowing
 * arbitrary amounts would let an unusual value correlate a public shield leg with a later
 * anonymized bet, which collapses the anonymity back to the shield.
 */
export const TRANCHES: readonly bigint[] = [10n * DECIMALS, 100n * DECIMALS, 1000n * DECIMALS];

/** Anonymity sets below this are too small to bet into safely; the UI must warn. */
export const MIN_SAFE_ANONYMITY_SET = 5;

export function isValidTranche(amount: bigint): boolean {
  return TRANCHES.includes(amount);
}

/**
 * A bet's secret material, generated in the browser and held by the user.
 *
 * NOT key material in the STRK20 sense — it is a commitment nonce, never a viewing key,
 * and Blindpool never sees a viewing key. It must still never be written to a file in
 * this repository or sent to a server: losing it means the bet cannot be revealed, and
 * leaking it tells an observer which side that commitment took.
 */
export interface BetSecret {
  side: Side;
  nonce: bigint;
  secret: bigint;
}

/**
 * Commitment `c = Poseidon(side, nonce, secret)`.
 *
 * Poseidon because the Cairo side computes the same digest with `poseidon_hash_span`
 * over the same three felts in the same order — the contract must be able to verify
 * `H(revealed) == committed` exactly.
 */
export function computeCommitment(bet: BetSecret): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([SIDE_FELT[bet.side], bet.nonce, bet.secret]),
  );
}

/** Constant-time-ish equality on hex felts, normalizing representation first. */
export function commitmentMatches(commitment: string, bet: BetSecret): boolean {
  try {
    return num.toBigInt(computeCommitment(bet)) === num.toBigInt(commitment);
  } catch {
    return false;
  }
}

/**
 * 251-bit random felt from the platform CSPRNG.
 *
 * Bounded below the STARK field prime so the value is a valid felt, and drawn from
 * `crypto.getRandomValues` — never `Math.random`, whose output would let anyone who
 * knows the seed recompute a bettor's side.
 */
function randomFelt(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  // Clamp to 251 bits — comfortably inside the field, still ~2^251 of entropy.
  return v >> 5n;
}

/** Fresh secret material for a new bet. Call once per bet; never reuse a nonce. */
export function createBetSecret(side: Side): BetSecret {
  return { side, nonce: randomFelt(), secret: randomFelt() };
}

// ─── Epoch scheduling ───────────────────────────────────────────────────────────

export interface EpochSchedule {
  /** Unix seconds when epoch 0 opened. */
  startedAt: number;
  /** Epoch length in seconds. */
  durationSeconds: number;
  /** Seconds after an epoch closes during which reveals are accepted. */
  revealWindowSeconds: number;
}

/** Which epoch a timestamp falls in. Clamped at 0 for times before the market opened. */
export function epochAt(schedule: EpochSchedule, now: number): number {
  if (now < schedule.startedAt) return 0;
  return Math.floor((now - schedule.startedAt) / schedule.durationSeconds);
}

/** Unix seconds when the given epoch stops accepting commits. */
export function epochClosesAt(schedule: EpochSchedule, epoch: number): number {
  return schedule.startedAt + (epoch + 1) * schedule.durationSeconds;
}

/** Unix seconds when the given epoch stops accepting reveals. */
export function revealClosesAt(schedule: EpochSchedule, epoch: number): number {
  return epochClosesAt(schedule, epoch) + schedule.revealWindowSeconds;
}

export type EpochPhase = "COMMIT" | "REVEAL" | "SETTLED";

/**
 * Phase of a given epoch at time `now`.
 *
 * A bet may only be placed during COMMIT and only revealed during REVEAL. Missing the
 * reveal window forfeits the stake — the liveness cost of sealing the epoch, and the one
 * thing the UI must state plainly before the user signs.
 */
export function epochPhase(schedule: EpochSchedule, epoch: number, now: number): EpochPhase {
  if (now < epochClosesAt(schedule, epoch)) return "COMMIT";
  if (now < revealClosesAt(schedule, epoch)) return "REVEAL";
  return "SETTLED";
}

/** Seconds remaining in the current phase; 0 once the epoch has settled. */
export function secondsRemaining(schedule: EpochSchedule, epoch: number, now: number): number {
  const phase = epochPhase(schedule, epoch, now);
  if (phase === "COMMIT") return Math.max(0, epochClosesAt(schedule, epoch) - now);
  if (phase === "REVEAL") return Math.max(0, revealClosesAt(schedule, epoch) - now);
  return 0;
}

// ─── Anonymity set ──────────────────────────────────────────────────────────────

/** One on-chain commit, as an observer sees it: a denomination in an epoch. Side absent. */
export interface ObservedCommit {
  epoch: number;
  denomination: bigint;
}

export interface AnonymityAssessment {
  /** k = how many indistinguishable commits this bet would hide among, including itself. */
  k: number;
  safe: boolean;
  /** User-facing sentence. Always concrete — a number the bettor can act on. */
  message: string;
}

/**
 * k(epoch, denom) = |{ commits of this denomination in this epoch }|, counting the
 * prospective bet itself.
 *
 * Shown before the user signs, because a privacy claim the user cannot see is a claim
 * they cannot check. Note this is an upper bound on real anonymity: an adversary who
 * placed some of those commits themselves knows to discount their own, so a k of 5 where
 * 3 are the adversary's is really a k of 2. That limit belongs in the threat model.
 */
export function assessAnonymity(
  observed: readonly ObservedCommit[],
  epoch: number,
  denomination: bigint,
): AnonymityAssessment {
  const k =
    observed.filter((c) => c.epoch === epoch && c.denomination === denomination).length + 1;
  const safe = k >= MIN_SAFE_ANONYMITY_SET;
  return {
    k,
    safe,
    message: safe
      ? `Your bet is 1 of ${k} identical commits this epoch.`
      : `Only ${k} commit${k === 1 ? "" : "s"} of this size this epoch — too few to hide in. ` +
        `Wait for the next epoch, or pick a denomination others are using.`,
  };
}
