# Blindpool — Cairo runbook

Everything needed to go from the stub in `src/blindpool.cairo` to a deployed contract on
Sepolia. Mainnet is a separate, deliberate step at the end, gated on an audit.

## 0. Toolchain

Already installed and verified on this machine:

```
scarb   2.18.0
snforge 0.63.0
sncast  0.63.0
```

If you're on a different machine:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh -s -- -v 2.18.0
curl -sSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh
snfoundryup
```

`snforge` and `sncast` land in `~/.foundry/bin`, `scarb` in `~/.local/bin`.

## 1. The loop you actually work in

```bash
cd cairo
snforge test          # 15 tests: 1 passes, 14 fail on TODO_*
scarb build           # compile only
```

**Definition of done: `snforge test` is green.** The 14 failing tests in
`tests/test_blindpool.cairo` are the acceptance criteria, and they encode every invariant
that `spec/Blindpool.tla` model-checks. Write bodies in `src/blindpool.cairo` until they
pass; don't weaken a test to make it go green — each one corresponds to a property, and
the mapping is listed at the top of the test file.

`test_commitment_matches_typescript` passes **today** and must keep passing. It pins
Cairo's Poseidon against the value `computeCommitment()` produces in
`src/lib/blindpool/epoch.ts`. If it ever fails, the dapp and the contract disagree about
what a position is, every reveal fails on a live market, and every stake forfeits.

## 2. What to read before writing anything

1. **`src/echo.cairo`** — the starter kit's helper, and the only *working* `privacy_invoke`
   against the live pool. It answers the mechanical questions: the pool is the caller, it
   has already sent the tokens by the time invoke runs (withdraw precedes invoke), and
   approving the pool is what lets it pull value back to fill an open note.
2. **`../spec/CONTRACTS.md`** — storage layout, entrypoint guards, payout arithmetic,
   ranked audit focus.
3. **`packages/ekubo_swap_anonymizer`** and **`packages/vesu_lending_anonymizer`** in
   https://github.com/starkware-libs/starknet-privacy — real anonymizers to pattern-match
   against. Skeletons, not templates.
4. **`InboundAnonymizer`** in https://github.com/starkware-libs/privacy-bridge — the
   closest published example of binding a commitment to a note.

## 3. Account setup

Accounts live in `~/.starknet_accounts/`, outside this repo. Never put a private key in a
file here.

```bash
export ALCHEMY_KEY=...      # free at https://www.alchemy.com
export STARKNET_RPC="https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/$ALCHEMY_KEY"

# Import an existing funded Sepolia account
sncast account import \
  --name blindpool_sepolia \
  --address 0xYOUR_ADDRESS \
  --private-key 0xYOUR_KEY \
  --type oz
```

Fund it from a Sepolia faucet before declaring — a declare costs gas.

## 4. Deploy to Sepolia

```bash
export ALCHEMY_KEY=...
export ADMIN=0x...    # the address that creates and resolves markets
export TOKEN=0x...    # STRK on Sepolia
./scripts/deploy.sh
```

The script builds, declares (tolerating an already-declared class), deploys with
`(pool, admin, token)` as constructor args, and prints the class hash and address. Sepolia
addresses are deliberately **not** written into `strk20.json` — that file records what is
live on mainnet, and a Sepolia address there would misreport the project.

## 5. Wire the dapp

Put the deployed address where the frontend can read it, as an env var — not a literal:

```bash
# .env.local  (gitignored)
NEXT_PUBLIC_BLINDPOOL_ANONYMIZER_SEPOLIA=0x...
```

Then verify end to end against the Ready extension: commit a bet, wait for the epoch to
close, reveal, and confirm the aggregate moves **only** at reveal. That last check is
`EpochMonotonic` observed on a real chain rather than in a model.

## 6. Mainnet — after the audit, not before

```bash
NETWORK=mainnet ADMIN=0x... ./scripts/deploy.sh
```

The script requires typing `mainnet` to confirm, and appends the resulting address to
`../strk20.json`.

**Do not run this before an audit.** The contract custodies stakes and computes
settlement; the ranked focus areas are in `../spec/CONTRACTS.md` §4, and the first two —
caller authorization on every state-changing entrypoint, and the commitment check in
`reveal` — are where a bug would be both easiest to introduce and most costly.

## 7. Known gaps in this scaffolding

- The payload layouts in `interfaces.cairo` are asserted by the TypeScript tests and the
  snforge tests **against each other**, never yet against the live pool. The first Sepolia
  invoke is the real test of whether the pool forwards calldata the way both sides assume.
- `settle_epoch` sweeping unrevealed commits needs an iteration strategy over that epoch's
  commits; the storage layout in `spec/CONTRACTS.md` does not yet prescribe one, and a
  naive unbounded loop will hit gas limits on a busy epoch. Decide this before writing the
  body — it is the one design question the spec leaves genuinely open.
