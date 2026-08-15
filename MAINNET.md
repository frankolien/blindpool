# Mainnet runbook — the three sprint transactions

The sprint asks for three Starknet **mainnet** transaction hashes that touched the STRK20
pool at `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`.

**These do not need the Blindpool contracts.** Shield, private transfer and unshield all
touch the pool and all work today from the wallet panel. That decouples a hard sprint
requirement from the critical path, so it can be banked now rather than in the last week.

This is legitimate rather than gaming: Blindpool genuinely uses these flows — a bettor
shields before betting and unshields after claiming, and §5.2 of the integration plan
depends on the shield being a separate earlier transaction.

## Before you start

- **Ready wallet** on **Mainnet**, with STRK for stakes and fees.
- The app running locally (`npm run dev`) or the deployment.
- An Alchemy key in `.env.local` as `NEXT_PUBLIC_PROVIDER_URL` — without it the RPC
  calls fail and you will not see receipts.

Budget real STRK: the amounts below are small, but pool fees are on top of gas and current
wallet flows sponsor gas but **not** pool fees.

## The three transactions

Run them as **three separate transactions**, not bundled. Bundling a shield with the
action it funds publishes "this address put in X" beside that action, and an observer
correlates them trivially — the composition leak described in `spec/THREAT_MODEL.md` §4.4.
Doing it correctly here also demonstrates the point on-chain.

1. **Shield** — deposit 10 STRK into the pool. Public by design: the depositor and amount
   are visible. Copy the hash.
2. **Private transfer** — 1 STRK in-pool to yourself. This is the leg with no public
   sender or recipient.
3. **Unshield** — withdraw 1 STRK back to your public balance.

A screening decline is a protocol outcome, not an app bug — deposit screening is enforced
on-chain from protocol v0.14.3 and applies to every route. If it happens, surface it and
try a different account; do not treat it as something to work around.

## Record them

```bash
export ALCHEMY_KEY=...
node scripts/record-tx.mjs 0xSHIELD 0xTRANSFER 0xUNSHIELD
```

The script fetches each receipt, rejects anything reverted, and refuses to record a hash
whose receipt carries no event emitted by the pool. Only verified hashes reach
`strk20.json`. Then:

```bash
git add strk20.json && git commit -m "Record three mainnet pool transactions" && git push
```

The hub re-reads the repository within about half an hour, and `verified_txs` and
`requirements.mainnet` update on your entry.

## What this does not do

Flipping `mainnet: true` records that Blindpool moved value through the pool. It does not
demonstrate the sealed-epoch mechanism, which needs the deployed anonymizer
(`cairo/SEPOLIA.md`). Bank these three now so the requirement is not sitting on the
critical path, then make the demo video about the mechanism.
