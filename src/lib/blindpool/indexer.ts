// Reading Blindpool activity back off the chain.
//
// The rule that governs this whole file: **a private transaction's `sender` is the
// relayer, not the user.** Private transactions are relayed, so every user's activity
// arrives from the same account with a very high nonce. Two queries look correct and are
// silently wrong:
//
//   transactions where sender == user      -> always empty
//   group activity by sender               -> one address appears to have made every bet
//
// Neither throws. Teams lose hours to the indexer, the block range and the RPC before
// questioning the field. Attribution comes from the pool's `Deposit` event, filtered on
// its FIRST INDEXED KEY (topic1), which is the depositing account.

import { hash, num, type ProviderInterface } from "starknet";
import { STRK20_POOL_ADDRESS } from "./strk20";
import type { ObservedCommit } from "./epoch";

/** `Deposit` on the STRK20 pool. topic1 (keys[1]) is the depositing account. */
export const DEPOSIT_EVENT_KEY = num.toHex(hash.getSelectorFromName("Deposit"));

/** `Committed` on BlindpoolMarket — keys: [selector, market_id, epoch]. */
export const COMMITTED_EVENT_KEY = num.toHex(hash.getSelectorFromName("Committed"));

/** `EpochSettled` on BlindpoolMarket — keys: [selector, market_id, epoch]. */
export const EPOCH_SETTLED_EVENT_KEY = num.toHex(hash.getSelectorFromName("EpochSettled"));

export interface BlockRange {
  fromBlock: number;
  toBlock: number | "latest";
}

interface RawEvent {
  from_address?: string;
  keys?: string[];
  data?: string[];
  block_number?: number;
}

/**
 * Page through `getEvents`, which is chunked and continuation-token driven. A single call
 * silently returns only the first chunk, which reads as "quiet market" rather than
 * "incomplete query" — so paginate or don't bother.
 */
async function fetchAllEvents(
  provider: ProviderInterface,
  address: string,
  key: string,
  range: BlockRange,
  chunkSize = 100,
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let continuationToken: string | undefined;

  do {
    const page: any = await provider.getEvents({
      address,
      from_block: { block_number: range.fromBlock },
      to_block: range.toBlock === "latest" ? "latest" : { block_number: range.toBlock },
      keys: [[key]],
      chunk_size: chunkSize,
      ...(continuationToken ? { continuation_token: continuationToken } : {}),
    });
    out.push(...((page?.events ?? []) as RawEvent[]));
    continuationToken = page?.continuation_token;
  } while (continuationToken);

  return out;
}

/**
 * Accounts that have shielded into the pool within a block range.
 *
 * This is the ONLY correct way to attribute pool activity to an account. Note carefully
 * what it is not: it says who deposited, never who bet. A deposit is public and a bet is
 * not, and joining the two is exactly the correlation attack in
 * spec/THREAT_MODEL.md §4.4 — so this must never be used to build a bettor leaderboard.
 * It exists to power the "you shielded and bet in the same epoch" warning, which uses
 * the correlation to protect the user rather than to expose them.
 */
export async function fetchDepositors(
  provider: ProviderInterface,
  range: BlockRange,
  poolAddress: string = STRK20_POOL_ADDRESS,
): Promise<{ account: string; blockNumber: number }[]> {
  const events = await fetchAllEvents(provider, poolAddress, DEPOSIT_EVENT_KEY, range);
  return events
    .map((e) => {
      // keys[0] is the event selector; keys[1] (topic1) is the depositing account.
      const account = e.keys?.[1];
      if (!account) return null;
      return { account: num.toHex(account), blockNumber: e.block_number ?? 0 };
    })
    .filter((x): x is { account: string; blockNumber: number } => x !== null);
}

/**
 * Commits observed on a market, as an adversary sees them: epoch and denomination only.
 *
 * Feeds `assessAnonymity` so the k-value shown to a user is computed from the same public
 * data an observer has — a privacy meter built from privileged information would be
 * measuring the wrong thing.
 */
export async function fetchObservedCommits(
  provider: ProviderInterface,
  marketContract: string,
  marketId: string | number,
  range: BlockRange,
): Promise<ObservedCommit[]> {
  const events = await fetchAllEvents(provider, marketContract, COMMITTED_EVENT_KEY, range);
  const wanted = num.toBigInt(num.toHex(marketId));

  return events
    .filter((e) => {
      try {
        return e.keys?.[1] !== undefined && num.toBigInt(e.keys[1]) === wanted;
      } catch {
        return false;
      }
    })
    .map((e) => {
      try {
        // keys: [selector, market_id, epoch]; data: [commitment, denomination(u256 lo,hi)]
        const epoch = Number(num.toBigInt(e.keys![2]));
        const denomination = num.toBigInt(e.data![1]);
        return { epoch, denomination };
      } catch {
        return null;
      }
    })
    .filter((c): c is ObservedCommit => c !== null);
}

export interface EpochAggregate {
  epoch: number;
  yes: bigint;
  no: bigint;
  forfeited: bigint;
}

/**
 * Per-epoch aggregates, published once per epoch at settlement.
 *
 * These are the only volume numbers that exist — there is deliberately no mid-epoch
 * aggregate to read, which is `EpochMonotonic` in spec/Blindpool.tla. If a future change
 * makes running totals queryable, the mechanism has leaked and the spec will say so.
 */
export async function fetchEpochAggregates(
  provider: ProviderInterface,
  marketContract: string,
  marketId: string | number,
  range: BlockRange,
): Promise<EpochAggregate[]> {
  const events = await fetchAllEvents(
    provider,
    marketContract,
    EPOCH_SETTLED_EVENT_KEY,
    range,
  );
  const wanted = num.toBigInt(num.toHex(marketId));

  return events
    .filter((e) => {
      try {
        return e.keys?.[1] !== undefined && num.toBigInt(e.keys[1]) === wanted;
      } catch {
        return false;
      }
    })
    .map((e) => {
      try {
        return {
          epoch: Number(num.toBigInt(e.keys![2])),
          yes: num.toBigInt(e.data![0]),
          no: num.toBigInt(e.data![1]),
          forfeited: num.toBigInt(e.data![2]),
        };
      } catch {
        return null;
      }
    })
    .filter((a): a is EpochAggregate => a !== null)
    .sort((a, b) => a.epoch - b.epoch);
}

/** Roll per-epoch aggregates into the market-level volume the odds are derived from. */
export function totalVolumeFrom(aggregates: readonly EpochAggregate[]): {
  YES: bigint;
  NO: bigint;
  forfeited: bigint;
} {
  return aggregates.reduce(
    (acc, a) => ({
      YES: acc.YES + a.yes,
      NO: acc.NO + a.no,
      forfeited: acc.forfeited + a.forfeited,
    }),
    { YES: 0n, NO: 0n, forfeited: 0n },
  );
}
