// STRK20 privacy pool configuration.
//
// Blindpool holds every position as a STRK20 note. This module is the single
// place that knows where the pool lives and how we talk to it; nothing else in
// the app should hardcode a pool address.

import { constants } from "starknet";

/** The STRK20 privacy pool on Starknet mainnet. Positions live here as notes. */
export const STRK20_POOL_ADDRESS =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/** Mainnet. The sprint settles on SN_MAIN, not Sepolia. */
export const CHAIN_ID = constants.StarknetChainId.SN_MAIN;

/**
 * The ERC-20 positions are denominated in (STRK).
 * Re-exported from the starter-kit constants so there is one source of truth.
 */
export { addrSTRK as POSITION_TOKEN } from "@/utils/constants";

/**
 * Notes mature 10 blocks after creation before they can be spent, and proofs are
 * built against a block that far behind the tip. Anything that builds a proof
 * should derive its block from this rather than picking its own lag.
 */
export const NOTE_MATURITY_BLOCKS = 10;

/** The block a proof should be built against, given the current tip. */
export function provingBlockId(currentBlock: number): number {
  return currentBlock - NOTE_MATURITY_BLOCKS;
}

/**
 * RPC endpoint. The key is read from the environment and never committed —
 * see .env.example.
 */
export function mainnetNodeUrl(): string {
  const key = process.env.NEXT_PUBLIC_PROVIDER_URL;
  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_PROVIDER_URL is not set. Copy .env.example to .env.local and " +
        "paste your Alchemy key. Get one free at https://www.alchemy.com.",
    );
  }
  return `https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/${key}`;
}
