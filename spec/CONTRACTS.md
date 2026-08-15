# Blindpool — Cairo contract specification

**This repository does not contain these contracts, and this file is not Cairo.**
It is the specification to implement against. On-chain code that custodies stakes
and computes settlement is the team's to write, review, audit, deploy and
maintain — an agent-generated contract you have not reviewed is worse than no
contract, because it looks finished.

Two contracts. Adapt from the reference anonymizers in
https://github.com/starkware-libs/starknet-privacy
(`packages/ekubo_swap_anonymizer`, `packages/vesu_lending_anonymizer`) — skeletons
to learn the shape from, not templates to copy. For binding a commitment to a note,
read `InboundAnonymizer` in https://github.com/starkware-libs/privacy-bridge, the
closest published analogue to what Blindpool needs.

Pool (mainnet): `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`

---

## 1. `BlindpoolMarket` — registry, aggregation, settlement

Holds public market state and custodies stakes. Knows nothing about privacy; it
never sees a user address because only the anonymizer calls it.

### Storage

| Field | Type | Notes |
|---|---|---|
| `markets` | `Map<u64, Market>` | by market id |
| `commits` | `Map<(u64, felt252), Commit>` | (market, commitment) → commit |
| `epoch_volume` | `Map<(u64, u32, u8), u256>` | (market, epoch, side) → revealed volume |
| `epoch_commit_count` | `Map<(u64, u32, u256), u32>` | (market, epoch, denom) → count, for `k` |
| `nullifiers` | `Map<(u64, felt252), bool>` | claimed commitments |
| `anonymizer` | `ContractAddress` | the only permitted caller of state-changing entrypoints |
| `token` | `ContractAddress` | STRK |

```
struct Market {
  question_hash: felt252,      // hash of question text; full text off-chain
  resolution_source_hash: felt252,
  started_at: u64,             // unix seconds, epoch 0 open
  epoch_duration: u64,
  reveal_window: u64,
  total_epochs: u32,
  status: u8,                  // 0 OPEN, 1 CLOSED, 2 RESOLVED
  outcome: u8,                 // 0 NONE, 1 YES, 2 NO
  forfeited: u256,             // stakes never revealed, added to the winning pot
}

struct Commit {
  epoch: u32,
  denomination: u256,
  revealed_side: u8,           // 0 = not yet revealed
  stake_settled: bool,
}
```

### Entrypoints

All state-changing entrypoints **must** assert `get_caller_address() == anonymizer`.
A market that accepts direct calls from user accounts has no privacy at all — the
caller address would be the bettor.

| Entrypoint | Guard conditions |
|---|---|
| `create_market(...) -> u64` | admin only; `epoch_duration > 0`; `reveal_window > 0` |
| `commit(market_id, commitment, denomination)` | caller is anonymizer · market OPEN · `now < epoch_close(current)` · denomination ∈ {10,100,1000}·1e18 · commitment unused · stake received |
| `reveal(market_id, commitment, side, nonce, secret)` | caller is anonymizer · `poseidon_hash_span([side, nonce, secret]) == commitment` · in that commit's reveal window · not already revealed · `side ∈ {1,2}` |
| `settle_epoch(market_id, epoch)` | reveal window elapsed · sweeps unrevealed commits into `forfeited` |
| `resolve(market_id, outcome)` | admin/oracle · all epochs settled · status OPEN → RESOLVED |
| `claim(market_id, commitment) -> u256` | caller is anonymizer · status RESOLVED · commitment revealed on winning side · nullifier unset → set · returns payout |

### Payout

Parimutuel, floored, matching `payout()` in `src/lib/blindpool/market.ts` and
`PayoutFor` in `Blindpool.tla`:

```
winning = Σ epoch_volume[market, *, outcome]
losing  = Σ epoch_volume[market, *, other(outcome)] + forfeited
payout  = stake + (stake * losing) / winning        // integer division
```

Floor division is what makes conservation hold. **Do not round up**, and do not
"fix" the dust — the residue stays in the contract by design. A sweep of it must
never come out of a pot that still owes a claimant.

### Events

| Event | Keys (indexed) | Data |
|---|---|---|
| `Committed` | `market_id`, `epoch` | `commitment`, `denomination` |
| `Revealed` | `market_id`, `epoch` | `commitment`, `side` |
| `EpochSettled` | `market_id`, `epoch` | `yes_volume`, `no_volume`, `forfeited` |
| `Resolved` | `market_id` | `outcome` |
| `Claimed` | `market_id` | `commitment`, `amount` |

**Never index a user address** — there is none, and adding one would undo the
anonymizer.

### Invariants (mirror `Blindpool.tla`)

1. `Σ claimed payouts ≤ Σ stakes` — settlement never mints.
2. A commitment is claimable at most once (`nullifiers`).
3. No claim before `status == RESOLVED`.
4. `reveal` accepts only a preimage hashing to the stored commitment.
5. `epoch_volume` changes **only** inside `reveal` — never in `commit`. This is
   `EpochMonotonic`; violating it makes running odds computable and destroys the
   mechanism. It is the single most important line in the contract.
6. Every commit ends revealed or forfeited, never both, never neither.

---

## 2. `BlindpoolAnonymizer` — the privacy boundary

Called by the STRK20 pool, atomically, inside the user's private transaction. Its
only job is to perform the market action so the pool — not the user — is the
caller of record.

### Mandatory entrypoint

`privacy_invoke` is dispatched by the pool via a hardcoded selector. Its shape is
fixed by the protocol, not by Blindpool — take it from the reference anonymizers
rather than from this document.

Flow, per the STRK20 model:

1. Pool withdraws input tokens to the anonymizer.
2. Anonymizer performs the market action.
3. Any output tokens are returned and credited back as private notes.
4. Any revert rolls the whole thing back — no stranded tokens.

### Operations

| Operation | Token flow | Notes |
|---|---|---|
| `BET` | pool → anonymizer → market | stake locked; **no output note** |
| `CLAIM` | market → anonymizer → pool | payout amount known only at execution, so it lands in an **open note** (public amount, hidden owner) |
| `REVEAL` | none | pure state transition; no value moves |

### Guards

- Only the configured privacy pool may call. Assert it.
- Reject any denomination outside the tranche set. One arbitrary-amount bet
  fingerprints its bettor permanently, so this belongs on-chain and not only in
  the UI.
- Reject `side ∉ {1,2}`. Zero is what an uninitialised storage slot returns.
- Never store, log or emit anything derived from the user's account.

### Transaction composition (dapp side)

Verified against the working echo flow in `WalletAccountV6Tag.tsx:335-363`.
`"OPEN"`, `"${poolAddress}"`, `"${openNoteIds[0]}"` are literal placeholder strings
the wallet substitutes — passing them through `num.toHex()` breaks substitution
silently.

```ts
// BET — stake out, nothing back this transaction.
[
  { type: "withdraw", token: STRK, amount: num.toHex(tranche), recipient: ANONYMIZER },
  { type: "invoke",   contract: ANONYMIZER,
    calldata: [OP_BET, marketId, epochId, commitment, num.toHex(tranche), "${poolAddress}"] },
]

// CLAIM — payout amount unknown until settlement runs, so it lands in an open note.
[
  { type: "transfer", token: STRK, amount: "OPEN", recipient: connectedAddress },
  { type: "invoke",   contract: ANONYMIZER,
    calldata: [OP_CLAIM, marketId, commitment, side, nonce, secret,
               "${poolAddress}", "${openNoteIds[0]}"] },
]
```

Confirm against https://strk20-by-example.org/starknet-wallet-api/private-defi
before relying on it. Implemented in `src/lib/blindpool/bet.ts`, which is written
against this spec and **untested on-chain** until the contracts exist.

---

## 3. Testing (`snforge`)

- Commit → reveal → settle → resolve → claim, happy path.
- **Reveal with a wrong side / nonce / secret is rejected** — the anti-cheat property.
- Double claim rejected.
- Reveal after the window rejected; stake forfeits.
- Non-standard denomination rejected.
- Direct call from a non-anonymizer address rejected.
- Anonymizer revert → clean rollback, no stranded tokens.
- **Aggregates unchanged by `commit`** — the executable form of `EpochMonotonic`.
- Conservation over a randomized multi-bettor market: total paid ≤ total staked.

## 4. Audit

Non-negotiable before mainnet, and the item most likely to become the critical
path — line up an owner early rather than at the end. Focus areas, in order:

1. Caller authorization on every state-changing entrypoint.
2. The commitment check in `reveal` (a weak check lets a bettor switch sides after
   seeing the aggregate).
3. Nullifier handling in `claim`.
4. Arithmetic: floor division, `u256` overflow, the dust residue.
5. Atomicity and rollback across the pool → anonymizer → market boundary.
