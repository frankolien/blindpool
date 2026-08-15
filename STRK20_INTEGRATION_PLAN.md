# STRK20 Privacy Integration Plan — Blindpool

Generated 2026-08-15 by the strk20-privacy-integration skill. Statuses below were
current at generation time — re-verify the tracked items before building against
them. Freshness check run 2026-08-15; drift is recorded in §10.

---

## 1. Project snapshot

- **Stack**: Next.js 16.0.8, React 19.2.1, TypeScript 5.9.3, `starknet` 10.4.0,
  `@starknet-io/get-starknet-discovery` + `-wallet-standard` 6.0.2,
  `@starknet-io/types-js` 0.10.3, zustand 5.0.9. Scaffolded from
  [strk20-starter-kit](https://github.com/Akashneelesh/strk20-starter-kit).
- **Relevant code**:
  - Wallet discovery / connect — `src/app/components/client/WalletHandle/SelectWallet.tsx`
  - STRK20 actions (shield, unshield, private transfer, echo) —
    `src/app/components/client/WalletHandle/WalletAccountV6Tag.tsx`
  - Providers + pool/network gating — `src/utils/constants.ts`
  - Pool config, proving-block derivation — `src/lib/blindpool/strk20.ts`
  - Public market model, odds, parimutuel payout — `src/lib/blindpool/market.ts`
  - Cairo: `cairo/src/lib.cairo` is the starter kit's **echo helper only** — a
    round-trip demo, not Blindpool logic. Scarb present, **no snforge tests yet**.
- **Backend**: none. No server-held Starknet keys. Everything goes through the
  user's wallet.
- **Privacy goal (from interview)**: hide *which side a bettor took and when*, and
  prevent any persistent bettor identity from forming across markets — while
  keeping odds, volume and settlement publicly verifiable.
- **Environment**: Starknet mainnet (`SN_MAIN`) is the sprint target; build and
  test on Sepolia first (§8). Users hold Ready (privacy live on mainnet).

---

## 2. Chosen route: Privacy Wallet API via starknet.js + an app-specific anonymizer

Blindpool is a normal dapp — users bring their own wallet — so shield, unshield
and private transfer go through the **Privacy Wallet API via starknet.js**. But
placing a bet is a *protocol action* on Blindpool's own contract, and the Wallet
API alone cannot do that privately. That needs an **app-specific anonymizer**
invoked through `STRK20_INVOKE_ACTION`, which the Wallet API does expose.

This is the mixed Branch B case the skill describes: Wallet API for user flows,
plus one Cairo contract that Blindpool owns, audits, deploys and maintains.

**The rule this follows:** this app **never touches viewing keys** — the user's
wallet holds keys, manages notes and does the proving; Blindpool only asks it to
act.

**Shadow accounts are deliberately not used.** They shipped in the SDK on
2026-08-13 (renamed from sub-accounts), but they have **no Wallet API surface** —
driving them requires the viewing key in the clear, which a wallet will never
provide. §5.2 explains why Blindpool's commitment design does not need them.

---

## 3. What this delivers — hidden vs visible

| Private | Public |
|---|---|
| Which side a bettor took, during the epoch | The fact that an address shielded into the pool, and when |
| Ordering of bets inside an epoch | Shield and unshield amounts (the public ERC-20 legs) |
| Running odds inside an epoch (not computable) | Aggregate YES/NO volume at each epoch close |
| The bettor's address on every bet and claim | Bet tranche denomination and epoch |
| Any link between a bettor and a market, or across markets | Market question, deadline, resolution source, outcome |
| Which specific commitment a claimant holds — until they claim | The number of bets per epoch, and each claim's denomination |

**Honest limits — three of them, stated plainly:**

1. **Amounts are not hidden.** An anonymizer hides the *user's address*, not the
   value. Notes settling back are open notes carrying public amounts. Blindpool
   buys size-privacy with **fixed tranches**, not cryptography: your bet is
   indistinguishable from every other bet of the same denomination, and nothing
   more.
2. **Bet and claim are linked by the commitment**, inside a single market. Both
   legs are address-less, so this links a pseudonym to a pseudonym — never to a
   person — and the commitment is unique to that market.
3. **The public shield leg is the weakest point.** If a user shields an odd amount
   and immediately bets, timing plus amount can correlate them. Mitigated by
   tranche discipline and by shielding as a separate earlier transaction (§5.4),
   never mitigated completely.

---

## 4. Prerequisites & versions

- `starknet@10.4.0` — **already satisfied**. Pin `>= 10.4.0` explicitly; STRK20
  releases are on the npm `next` tag (`next` was 10.7.0 on 2026-08-15).
- `@starknet-io/get-starknet-discovery@6.0.4`,
  `@starknet-io/get-starknet-wallet-standard@6.0.4` — **upgrade from 6.0.2**
  (npm `next` tag — pin explicitly; the skill's 6.0.3 pin drifted, see §10).
- `@starknet-io/types-js@0.10.3` — already satisfied. Supplies `STRK20_ACTION`.
- Wallet API capability floor: `>= 0.10.3`, detected via
  `supportedWalletApi`/`supportedSpecs` — **never** by probing balances.
- Test wallet: Ready extension.
- Cairo: Scarb + Starknet Foundry (`snforge` for tests, `sncast` for deploy) —
  `snforge` is not yet set up in `cairo/`.
- Formal methods: TLA+ Toolbox or `tla2tools.jar` (TLC), and `fast-check` as a dev
  dependency for property tests.

---

## 5. System design — the sealed-epoch mechanism

This section is the design decision the rest of the plan implements. It is
Blindpool's actual contribution, so it is specified before any phase.

### 5.1 The problem the mechanism solves

A continuous public order book leaks side, size and timing on every bet. Hiding
the bettor's address does not fix this: an observer still watches the odds move
in real time and reacts. Front-running survives anonymity.

### 5.2 The mechanism

Markets advance in **epochs**. Within an epoch:

1. **Commit.** A bet posts `c = H(side ‖ nonce ‖ secret)` plus a **fixed tranche**
   (10 / 100 / 1000 STRK). On-chain, every commit in an epoch is
   indistinguishable apart from its denomination. Side is not in the clear, so
   **running odds are not computable mid-epoch**.
2. **Reveal.** After the epoch closes, holders reveal `(side, nonce, secret)`. The
   contract checks `H(side ‖ nonce ‖ secret) = c` and adds the tranche to that
   side's aggregate.
3. **Reprice.** Odds move exactly once per epoch, from aggregates only. No
   individual bet is ever attributed to a side in a way that identifies it as
   *that* bet from *that* commit.
4. **Claim.** After resolution, a winner claims against their commitment. A
   nullifier prevents double-claim.

Front-running is not obscured here, it is **structurally impossible**: the
information required to front-run does not exist on-chain until the epoch closes.

**Why no shadow accounts.** A position must survive from bet to claim, which
normally demands a persistent address per user — exactly what shadow accounts
provide, and exactly what the Wallet API cannot reach. The commitment *is* the
position, so the persistent identity lives in a hash the user holds off-chain, and
no account needs to persist at all. This is what makes Blindpool buildable today
rather than blocked on a pending wallet capability.

### 5.3 Cost, stated honestly

Commit-reveal has a **liveness assumption**: a bettor who never reveals has a
stake the contract cannot assign to a side. Blindpool handles this with a reveal
deadline and forfeiture to the winning pool, which is standard, simple, and
genuinely a UX cost — a user who closes the tab between commit and reveal loses
the stake. Alternatives (threshold decryption; timelock encryption) remove the
assumption but need infrastructure that is out of scope for this sprint.

This must be surfaced in the UI as an explicit warning before signing a commit,
not buried in docs.

### 5.4 Anonymity set — the metric, and the UI

For an observer, the anonymity set of a bet is

```
k(epoch, denom) = |{ commits of denomination `denom` in `epoch` }|
```

Blindpool computes `k` live and shows it **before the user signs**: *"your bet is
1 of 47 identical 100 STRK commits this epoch."* When `k < 5`, the UI warns and
offers to wait for the next epoch. This turns the privacy claim into a number the
user can see, and is the honest version of the "privacy simulator" idea.

Because the shield leg is public, the UI also warns when a user shields and bets
inside the same epoch (§3, limit 3).

### 5.5 Transaction composition

A bet is **one** `wallet_strk20InvokeTransaction` carrying an ordered action list:

```ts
actions: [
  { type: 'transfer', token: STRK, amount: 'OPEN', recipient: <pool> },
  { type: 'invoke',
    contract: BLINDPOOL_ANONYMIZER,
    calldata: [marketId, epochId, commitment, '${openNoteIds[0]}', '${poolAddress}'] },
]
```

`${openNoteIds[N]}` and `${poolAddress}` are wallet-resolved placeholders defined
in `@starknet-io/types-js@0.10.3`. **Verify the exact composition against
https://strk20-by-example.org/starknet-wallet-api/private-defi before writing
this** — do not treat the sketch above as final.

### 5.6 Reading activity back

Blindpool must **never** attribute a bet to a transaction sender: private
transactions are relayed, so `sender` is the relayer for every user and grouping
by it makes one address look like a whale that placed every bet. Any per-user or
per-market counting reads the pool's **`Deposit` event, filtering on its first
indexed key (topic1)**. This applies to the volume indexer, the anonymity-set
counter and anything resembling a leaderboard.

---

## 6. Formal methods

### 6.1 TLA+ specification — `spec/Blindpool.tla`

Model the market lifecycle `OPEN → SEALED → REVEALED → RESOLVED → CLAIMED` and
check with TLC over a small bounded model (2 sides, 3 bettors, 2 epochs, 2
denominations). Invariants:

| Invariant | Statement |
|---|---|
| `Conservation` | `Σ payouts ≤ Σ stakes` — settlement never mints |
| `NoDoubleClaim` | `claimed(c) ⇒ □ ¬claim(c)` — nullifier soundness |
| `NoEarlyClaim` | `claim(c) ⇒ status = RESOLVED` |
| `RevealBinding` | `reveal(c,s,r) ⇒ H(s,r) = c` — no side-switching after commit |
| `EpochMonotonic` | published odds change only at an epoch boundary |
| `NoForfeitDrift` | forfeited stakes are fully accounted to the winning pool |

`EpochMonotonic` is the one that encodes the actual privacy property — if TLC
finds a trace where odds move mid-epoch, the mechanism has leaked.

### 6.2 Property tests — `src/lib/blindpool/market.test.ts`

`fast-check` properties over the existing pure functions in
`src/lib/blindpool/market.ts`:

- `odds.YES + odds.NO = 1` for all volumes
- `payout(state, a) ≥ a` for a winner — a winner never loses stake
- `payout` is monotonic in `amount`
- `Σ payout(winners) ≤ totalVolume()` — conservation, executable
- empty market → `0.5 / 0.5`, no division by zero
- `oddsFor` never loses precision on bigint volumes near `2^128`

### 6.3 Contract tests — `cairo/tests/`

`snforge` tests on the anonymizer: atomic success, revert rollback (no stranded
tokens), double-claim rejection, reveal-after-deadline rejection, commit with a
non-standard denomination rejected.

### 6.4 Adversary model — `spec/THREAT_MODEL.md`

Adversary **A** has the full chain view and timing, no viewing key, and may place
bets to shrink other bettors' anonymity sets. Document the leakage function per
operation (`shield`, `commit`, `reveal`, `claim`) and state what A learns at each
step. This is the artifact that defends the privacy claim.

---

## 7. Phases

### Phase 1 — Wallet API foundation (buildable now)

1. Upgrade get-starknet to 6.0.4 in `package.json`; keep `starknet` at ≥ 10.4.0.
2. Capability-detect STRK20 via `supportedWalletApi`/`supportedSpecs` in
   `SelectWallet.tsx`; **never** call `wallet_strk20Balances` to feature-detect.
3. **Graceful degradation** — wallets without privacy support connect and can read
   public market state, with private actions disabled and labeled why. Not
   optional; part of this phase.
4. Wire shield / unshield off `WalletAccountV6Tag.tsx` into a Blindpool-shaped
   component, per the WalletAccount guide.
5. Verify against the Ready extension and https://starknet-wallet-account.vercel.app/.

### Phase 2 — Public market layer (no privacy dependency)

1. Market registry Cairo contract (`cairo/src/market.cairo`): question, deadline,
   resolution source, epoch schedule, per-side aggregates, outcome.
2. Replace the echo helper in `cairo/src/lib.cairo` — it is starter-kit demo code.
3. Indexer reading the pool's `Deposit` event (topic1) for volume and anonymity-set
   counts (§5.6).
4. Wire `src/lib/blindpool/market.ts` to real on-chain state; land §6.2 property
   tests alongside.

### Phase 3 — The anonymizer (Blindpool owns this contract)

1. Design on paper first: input tranche → commit/reveal/claim → settlement, in the
   withdraw → act → re-shield shape, with rollback behavior per action.
2. Study `packages/ekubo_swap_anonymizer` and `packages/vesu_lending_anonymizer` in
   https://github.com/starkware-libs/starknet-privacy as skeletons — not templates.
   Read `InboundAnonymizer` in the Privacy Bridge for the commitment-binding shape
   (`privacy_invoke_with_computation`), which is the closest published analogue to
   Blindpool's commit scheme.
3. Develop against the SDK-direct path **on Sepolia only**, where the team controls
   the account and keys. Production user flows stay on the Wallet API.
4. `snforge` tests per §6.3.
5. **Audit — non-negotiable before mainnet.** Owner and timing to be named now, not
   at the end. This skill does not write Cairo; Blindpool owns review, audit,
   deployment and maintenance.

### Phase 4 — Sprint deliverables

1. Three Starknet **mainnet** transactions touching the pool at
   `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`, recorded
   in `strk20.json` → `transactions`.
2. Deployed contract addresses → `contracts`.
3. 3-minute demo video → `demo_video`; deployment → `demo_url` (only if the repo
   Website field, GitHub Pages, or a Vercel/Netlify deploy does not already report
   it — those are picked up automatically).
4. TLA+ spec and threat model committed under `spec/`.

**Mainnet gate:** every phase above runs on Sepolia. Moving to mainnet requires
explicit confirmation at that moment, per §8.

---

## 8. Testing

Testnet-first throughout: Sepolia for all development, with the Ready extension
and the wallet test dapp for wallet-path verification. A pure-local devnet does
not exercise the wallet or proving path today, so it cannot replace this.

Mainnet is touched only for Phase 4, deliberately and with confirmation — the
sprint requires three mainnet transactions, which is a reason to plan the mainnet
run, not a reason to develop there.

Deposit screening is enforced on-chain from protocol v0.14.3 and applies on Sepolia
and mainnet alike; budget for a screening-rejected deposit as a real test case.

---

## 9. Compliance & security notes

- **Deposit screening is enforced on-chain by the protocol** and applies on every
  route. Self-hosted proving does not bypass it. Blindpool must never be presented
  as a screening workaround.
- **Selective disclosure** exists so the pool can disclose what is needed to answer
  a legitimate regulatory request without exposing unrelated users. It is not
  automatic compliance and carries no regulator endorsement.
- **Blindpool owns** its anonymizer contract end to end — review, audit,
  deployment, maintenance — plus its own legal/compliance posture and any
  use-case-specific KYC. A prediction market has jurisdictional exposure
  independent of anything in this plan.
- **No key material in files, ever.** Env-var placeholders only. If a step appears
  to need a user's viewing key, the route is wrong — return to §2.
- Fee UX: current wallet flows sponsor gas but not pool fees; shielded-token fee
  payment and paymaster-based estimation are still being designed. Do not promise a
  fee UX — re-check at build time.

---

## 10. Open items to re-verify at build time

- **get-starknet drifted** 6.0.3 → **6.0.4** (skill pin is stale). Confirm before
  pinning.
- **`packages/sub_account_anonymizer` no longer exists** — renamed to
  `packages/shadow_account_anonymizer` in the 0.14.3-RC.5 breaking change
  (2026-08-13). Selectors and event keys changed; historical `SubAccountDeployed`
  events keep the old key, so any indexer spanning the upgrade must match both.
- **Shadow accounts have no Wallet API surface** as of `types-js@0.10.3` — verified
  by inspecting `STRK20_ACTION`. If that changes, revisit §5.2: shadow accounts
  would allow a persistent unlinkable position holder and could simplify the claim
  path.
- Wallet API spec: v0.10.3 stable, **v0.10.4-rc.1 in flight**. Keep the capability
  check at `>= 0.10.3`.
- Xverse dapp-facing Wallet API status (in progress as of mid-July 2026) — Ready is
  the only confirmed test target.
- Confirm the exact `transfer`+`invoke` composition in §5.5 against the private-DeFi
  page before implementing.

---

## 11. Links

- What STRK20 is / pool model — https://strk20-by-example.org/what-is-strk20
- Notes, nullifiers, UTXO model — https://strk20-by-example.org/notes-and-nullifiers
- Actions, phases, proofs — https://strk20-by-example.org/actions-and-proofs
- Wallet API overview — https://strk20-by-example.org/starknet-wallet-api/overview
- starknet.js / `WalletAccountV6` — https://strk20-by-example.org/starknet-wallet-api/starknet-js
- **Private DeFi via open notes + invoke** — https://strk20-by-example.org/starknet-wallet-api/private-defi
- Anonymizer anatomy / `privacy_invoke` — https://strk20-by-example.org/helpers/privacy-invoke
- Lending/vault anonymizer example — https://strk20-by-example.org/helpers/vesu-lending-helper
- Compliance, screening, selective disclosure — https://strk20-by-example.org/compliance
- WalletAccount guide (fetch before coding) — https://starknet-js.com/docs/next/guides/account/walletAccount/#with-get-starknet-v6
- Privacy SDK monorepo — https://github.com/starkware-libs/starknet-privacy
- Privacy Bridge (commitment-binding reference) — https://github.com/starkware-libs/privacy-bridge
- Pool contract (mainnet) — https://voyager.online/contract/0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
- Whitepaper — https://eprint.iacr.org/2026/474
- Wallet test dapp — https://starknet-wallet-account.vercel.app/
- Cairo CoreStars Telegram — `@sncorestars`
