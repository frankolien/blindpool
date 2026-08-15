#!/usr/bin/env node
//
// Verify a Starknet mainnet transaction actually touched the STRK20 pool, then record it
// in strk20.json.
//
//   export ALCHEMY_KEY=...
//   node scripts/record-tx.mjs 0xTXHASH [0xTXHASH...]
//
// The verification is the point. The sprint asks for three mainnet hashes that touched the
// pool at 0x0403…812a; pasting a hash by hand and hoping is how a project gets marked
// unverified. This checks the receipt for an event emitted by the pool and refuses to
// record anything that does not have one.

import { readFileSync, writeFileSync } from "node:fs";
import { RpcProvider, num } from "starknet";

const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const STRK20_JSON = new URL("../strk20.json", import.meta.url);

const key = process.env.ALCHEMY_KEY;
if (!key) {
  console.error("Set ALCHEMY_KEY. Free key at https://www.alchemy.com");
  process.exit(1);
}

const hashes = process.argv.slice(2);
if (hashes.length === 0) {
  console.error("Usage: node scripts/record-tx.mjs 0xTXHASH [0xTXHASH...]");
  process.exit(1);
}

const provider = new RpcProvider({
  nodeUrl: `https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/${key}`,
});

const poolBig = num.toBigInt(POOL);
const verified = [];

for (const hash of hashes) {
  process.stdout.write(`${hash} … `);
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(hash);
  } catch (err) {
    console.log(`✗ could not fetch (${err?.message ?? err})`);
    continue;
  }

  const r = receipt?.value ?? receipt;
  if (r?.execution_status === "REVERTED") {
    console.log("✗ reverted — a reverted transaction is not evidence of anything");
    continue;
  }

  const events = r?.events ?? [];
  const touchedPool = events.some((e) => {
    try {
      return num.toBigInt(e.from_address) === poolBig;
    } catch {
      return false;
    }
  });

  if (!touchedPool) {
    console.log(`✗ no event from the pool (${events.length} events in receipt)`);
    continue;
  }

  console.log("✓ touched the STRK20 pool");
  verified.push(num.toHex(hash));
}

if (verified.length === 0) {
  console.error("\nNothing verified — strk20.json unchanged.");
  process.exit(1);
}

const json = JSON.parse(readFileSync(STRK20_JSON, "utf8"));
const before = json.transactions.length;
for (const h of verified) {
  if (!json.transactions.some((t) => num.toBigInt(t) === num.toBigInt(h))) {
    json.transactions.push(h);
  }
}
writeFileSync(STRK20_JSON, `${JSON.stringify(json, null, 2)}\n`);

console.log(
  `\nstrk20.json: ${before} → ${json.transactions.length} transactions.` +
    (json.transactions.length >= 3
      ? " Sprint requirement met — commit and push."
      : ` ${3 - json.transactions.length} more needed.`),
);
