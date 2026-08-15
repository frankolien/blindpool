# Blindpool — threat model and leakage analysis

Companion to `Blindpool.tla`. That spec checks what the mechanism *does*;
this document states what an observer *learns*, which is the property a
privacy app is actually judged on and which no model checker can decide.

Written 2026-08-15. Everything here describes the design in
`STRK20_INTEGRATION_PLAN.md` §5; where the implementation does not yet exist,
it says so.

---

## 1. Adversary

**A** is a passive-plus-participating observer:

| Capability | Has it |
|---|---|
| Full historical and live view of Starknet state and events | ✅ |
| Transaction timing at block granularity | ✅ |
| Can place bets itself, in any epoch, at any denomination | ✅ |
| Can read every Blindpool contract's storage | ✅ |
| Can run its own indexer over pool `Deposit` events | ✅ |
| Any user's viewing key | ❌ |
| Ability to break Poseidon preimage resistance | ❌ |
| Ability to forge a STARK proof the pool accepts | ❌ |
| Control of the sequencer / transaction ordering | ❌ (see §6) |

The last exclusion is a real assumption, not a formality. A sequencer-level
adversary sees transactions before inclusion and is outside what this design
defends against.

---

## 2. Leakage function

`L(op)` is what **A** observes from each operation. Anything not listed is not
published by that operation.

```
L(shield(addr, v))        = { depositor: addr, amount: v, block: t }
L(commit(c, denom))       = { commitment: c, denomination: denom,
                              market, epoch, block: t }
                            side      ⊥
                            bettor    ⊥
                            position  ⊥
L(reveal(c, side, nonce)) = { commitment: c, side, block: t }
                            ⊕ epoch aggregate becomes public
                            bettor    ⊥
L(claim(c))               = { commitment: c, denomination, block: t }
                            claimant  ⊥
L(unshield(addr, v))      = { recipient: addr, amount: v, block: t }
```

`⊥` = not derivable from that operation alone. The qualifier matters: §4 is
entirely about deriving those values by *combining* operations.

---

## 3. What the mechanism buys

**Mid-epoch, running odds do not exist on-chain.** `EpochMonotonic` in the TLA+
spec is the machine-checked statement of this. **A** cannot compute the book
before an epoch closes, so front-running is not obscured — the information
required for it has not been published. This is the design's central claim and
the one part of it that is formally verified.

**No persistent bettor identity.** A bet is a commitment, not an account. There
is no address to accumulate a track record against, so "follow the smart money"
has no referent. This holds *across* markets unconditionally, because commitments
in different markets are independent values.

**Address hiding on both legs.** Bet and claim both run through the anonymizer,
so neither carries a user address.

---

## 4. What still leaks — the honest part

### 4.1 Amounts are public, always

An anonymizer hides the address, not the value; notes settling back are open
notes with public amounts. Fixed tranches are the *entire* size-privacy story:
a bet is indistinguishable from other bets **of the same denomination in the
same epoch**, and nothing more. This is k-anonymity, not cryptographic hiding.

### 4.2 The anonymity set is an upper bound, and A can shrink it

`k(epoch, denom)` counts commits **A** can see — including **A**'s own. An
adversary that places 3 of the 5 commits in a bucket faces a real anonymity set
of 2, while the UI honestly reports 5, because the UI cannot tell which commits
are the adversary's.

**This is a genuine weakness with no clean fix at this layer.** Mitigations that
would help and are *not* implemented: minimum-participant thresholds before an
epoch settles, per-address commit rate limits (which reintroduce addresses), or
proof-of-burn costs on commits. The UI must not imply `k` is a guarantee.

### 4.3 Commitment links bet to claim within a market

`c` appears at commit, reveal and claim. **A** therefore links those three events
to one another — pseudonym to pseudonym, never to a person, and only inside a
single market. Cross-market linkage does not follow.

### 4.4 The public shield leg is the weakest point

Shielding is public by construction: depositor and amount both. The attack:

```
t₀   0xAB shields 4,317 STRK          (public, named)
t₁   commit, denomination 1000 STRK   (anonymized)
```

If **A** sees one address shield an unusual amount shortly before a commit, the
correlation is strong. Defences in the design:

- **Tranche discipline** — bets are 10/100/1000, so the *bet* never carries an
  unusual value.
- **Separate transactions** — never bundle a shield with the bet it funds. A
  bundled deposit publishes "this address put in X" beside the action it paid
  for, and **A** correlates trivially. (STRK20 concepts: composition leaks.)
- **Time separation** — the UI must warn when a user shields and bets in the
  same epoch. *Not yet implemented; tracked in the plan.*

Residual risk stays non-zero. A user who shields exactly 1000 STRK and bets
1000 STRK four minutes later is correlated regardless of what the app does.

### 4.5 Reveal-time side disclosure

At reveal, `(c, side)` becomes public. Because `c` was already public at commit,
**A** learns *that commitment* took *that side*. What A does not learn is who
holds it. Aggregates are what reprice the market; per-commitment sides are a
byproduct of a user-driven reveal.

A design that hides per-commitment sides entirely needs threshold or timelock
decryption so only the sum is ever opened. Out of scope for this sprint, and the
honest upgrade path if Blindpool continues past it.

### 4.6 Forfeiture is observable

A commitment that never reveals is visible as such, and its stake moves to the
winning pool. **A** learns "someone committed this denomination and walked away."
Low sensitivity, but it is a distinguishing event: a bettor who always reveals
and one who sometimes forfeits are behaviourally different, though not linkable
without another handle.

### 4.7 Timing within an epoch

Commits are separate transactions with distinct block positions. Within an epoch
**A** sees *when* each commit landed, just not what it was. Ordering is therefore
public even though content is not — this is why epoch length is a privacy
parameter, not just a UX one. Short epochs mean small `k` and fine-grained
timing; long epochs mean better anonymity and a worse-feeling market.

---

## 5. Implementation obligations

Properties that hold in the design and can be lost in code:

1. **Never attribute activity to a transaction sender.** Private transactions are
   relayed; `sender` is the relayer for everyone. Per-user counting reads the
   pool's `Deposit` event and filters on its **first indexed key (topic1)**.
   Grouping by `sender` silently reports one whale making every bet.
2. **Never probe `strk20Balances` to feature-detect.** It prompts the user to
   disclose shielded balances to answer a question the advertised spec version
   already answers. Enforced in `src/lib/blindpool/capability.ts`.
3. **Secrets come from `crypto.getRandomValues`.** `Math.random` is predictable;
   an adversary who reconstructs the seed recovers sides. Enforced in
   `src/lib/blindpool/epoch.ts`.
4. **A bet secret must never leave the browser.** Not to a server, not to logs,
   never written into this repository. Losing it forfeits the stake; leaking it
   reveals the side.
5. **Reject non-standard denominations client- and contract-side.** One
   arbitrary-amount bet fingerprints its bettor permanently.

---

## 6. Out of scope

- **Sequencer-level adversary** — sees transactions pre-inclusion; not defended.
- **Deposit screening** is enforced on-chain by the STRK20 protocol from v0.14.3
  and applies on every route. Blindpool neither implements nor circumvents it,
  and must never be described as a way around it.
- **Selective disclosure** exists in the pool so a legitimate regulatory request
  can be answered without exposing unrelated users. It is not automatic
  compliance and carries no endorsement.
- **Oracle/resolution risk.** A market resolving against a declared source
  inherits that source's trustworthiness. Orthogonal to privacy, and a real
  product risk.
- **Legal exposure.** Prediction markets are regulated differently across
  jurisdictions. Not a privacy question, and not addressed here.
