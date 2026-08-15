
// Bet, reveal and claim transaction composition.
//
// Written against spec/CONTRACTS.md §2. The anonymizer does not exist yet, so nothing
// here has run on-chain — the composition follows the working echo flow in
// WalletAccountV6Tag.tsx:335-363, which is the only verified example of the
// withdraw → invoke → open-note shape in this repo.
//
// The action lists are built by pure functions so they can be asserted in tests without
// a wallet: getting the placeholder handling wrong is a silent failure at signing time,
// which is the worst possible place to discover it.

import { num } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import { computeCommitment, isValidTranche, type BetSecret } from "./epoch";
import { SIDE_FELT } from "./epoch";

/**
 * Operation discriminator, first calldata element. Explicit rather than one entrypoint
 * per operation because the pool dispatches `privacy_invoke` by hardcoded selector — the
 * anonymizer routes internally.
 */
export const OP = { BET: "0x1", REVEAL: "0x2", CLAIM: "0x3" } as const;

/**
 * Wallet-resolved placeholders. These are literal strings the wallet substitutes during
 * action assembly.
 *
 * They must NEVER be passed through num.toHex(): normalizing them produces a valid-looking
 * felt that the wallet does not recognize as a placeholder, so substitution silently does
 * not happen and the invoke receives a garbage note id. The starter kit flags this at
 * WalletAccountV6Tag.tsx:343.
 */
export const POOL_ADDRESS_PLACEHOLDER = "${poolAddress}";
export const openNotePlaceholder = (n: number) => `\${openNoteIds[${n}]}`;

/**
 * The pool forwards this calldata array positionally as `privacy_invoke`'s arguments, so
 * the array *is* the signature:
 *
 *   [token, ${poolAddress}, note_id, payload_len, ...payload]
 *
 * A Cairo entrypoint has one fixed arity but a BET carries different parameters than a
 * CLAIM, so the operation-specific part travels in a trailing `Span<felt252>`, which
 * Serde encodes as a length followed by its items. `note_id` is 0 for operations that
 * request no open note.
 *
 * Mirrors `IBlindpool::privacy_invoke` in cairo/src/interfaces.cairo — change one and you
 * must change the other, or the dapp and the contract silently disagree.
 */
function invokeCalldata(
  token: string,
  noteId: string,
  payload: string[],
): string[] {
  return [num.toHex(token), POOL_ADDRESS_PLACEHOLDER, noteId, num.toHex(payload.length), ...payload];
}

/** u256 as Serde encodes it: low then high felt. */
function u256Felts(v: bigint): [string, string] {
  const MASK = (1n << 128n) - 1n;
  return [num.toHex(v & MASK), num.toHex(v >> 128n)];
}

/** No open note is requested by BET or REVEAL — nothing is credited back. */
const NO_NOTE = "0x0";

export interface BetParams {
  anonymizer: string;
  token: string;
  marketId: string | number;
  epoch: number;
  tranche: bigint;
  secret: BetSecret;
}

/**
 * Place a bet: stake leaves the pool to the anonymizer, and nothing comes back in this
 * transaction — the position is the commitment, held off-chain by the bettor.
 *
 * No open note here. An open note exists to receive a value the contract computes; a bet's
 * stake is known up front and its receipt is the commitment, so requesting one would
 * create a note the anonymizer has nothing to fill.
 */
export function buildBetActions(p: BetParams): WALLET_API.STRK20_ACTION[] {
  if (!isValidTranche(p.tranche)) {
    throw new Error(
      `${p.tranche} is not an allowed tranche. Arbitrary amounts fingerprint the bettor ` +
        `against the public shield leg — see spec/THREAT_MODEL.md §4.4.`,
    );
  }
  const commitment = computeCommitment(p.secret);
  return [
    {
      type: "withdraw",
      token: p.token,
      amount: num.toHex(p.tranche),
      recipient: p.anonymizer,
    },
    {
      type: "invoke",
      contract: p.anonymizer,
      calldata: invokeCalldata(p.token, NO_NOTE, [
        OP.BET,
        num.toHex(p.marketId),
        num.toHex(p.epoch),
        commitment,
        ...u256Felts(p.tranche),
      ]),
    },
  ];
}

export interface RevealParams {
  anonymizer: string;
  token: string;
  marketId: string | number;
  secret: BetSecret;
}

/**
 * Open a commitment after its epoch closes. No value moves — this is a pure state
 * transition that adds the stake to its side's aggregate.
 *
 * Missing the reveal window forfeits the stake. That is the liveness cost of sealing the
 * epoch, and the UI must say so before the user signs the bet, not here.
 */
export function buildRevealActions(p: RevealParams): WALLET_API.STRK20_ACTION[] {
  return [
    {
      type: "invoke",
      contract: p.anonymizer,
      calldata: invokeCalldata(p.token, NO_NOTE, [
        OP.REVEAL,
        num.toHex(p.marketId),
        computeCommitment(p.secret),
        num.toHex(SIDE_FELT[p.secret.side]),
        num.toHex(p.secret.nonce),
        num.toHex(p.secret.secret),
      ]),
    },
  ];
}

export interface ClaimParams {
  anonymizer: string;
  token: string;
  marketId: string | number;
  /** The user's own address — open notes are credited to the claimant, not the pool. */
  recipient: string;
  secret: BetSecret;
}

/**
 * Claim a winning position. The payout is only known once settlement arithmetic has run,
 * so it lands in an open note: public amount, hidden owner.
 *
 * Unshielding is deliberately a separate, later transaction. Bundling it here would
 * publish a withdrawal beside the claim that produced it and hand an observer the
 * correlation the whole mechanism exists to deny.
 */
export function buildClaimActions(p: ClaimParams): WALLET_API.STRK20_ACTION[] {
  return [
    {
      type: "transfer",
      token: p.token,
      amount: "OPEN",
      recipient: p.recipient,
    },
    {
      type: "invoke",
      contract: p.anonymizer,
      // The open-note placeholder is the note_id argument, not a payload item — the pool
      // substitutes it in place, and the contract returns an OpenNoteDeposit naming it.
      calldata: invokeCalldata(p.token, openNotePlaceholder(0), [
        OP.CLAIM,
        num.toHex(p.marketId),
        computeCommitment(p.secret),
        num.toHex(SIDE_FELT[p.secret.side]),
        num.toHex(p.secret.nonce),
        num.toHex(p.secret.secret),
      ]),
    },
  ];
}
