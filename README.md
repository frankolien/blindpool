# Blindpool

**Public odds. Invisible bettors.**

A prediction market on Starknet where the order book is fully public and every
position is shielded. Anyone can read the odds, the volume and the settlement
proof. Nobody can read who took which side, or for how much.

Built for the [STRK20 Private Sprint](https://github.com/starkience/strk20-hackathon)
(RFP-07), on the STRK20 privacy pool.

---

## The problem

Public prediction markets leak the one thing that matters most: position data.
Every bet is an open broadcast of conviction tied to a persistent address. That
produces three failures that get worse as a market gets more useful:

- **Copy-trading.** A wallet with a track record cannot take a position without
  the market immediately following it, which moves the price against them before
  the position is filled.
- **Front-running.** A large order is visible in the mempool and on settlement,
  so it can be raced.
- **Chilled participation.** Anyone whose opinion is sensitive — on an election,
  an employer, a public figure — is betting under their real, linkable identity.

The odds are the public good. The positions are not, and publishing them
degrades the very signal the market exists to produce.

## The approach

Blindpool splits market state in two.

| Public (on-chain, readable by anyone) | Private (shielded in the STRK20 pool) |
| --- | --- |
| Current YES/NO odds | Which address holds which position |
| Total pool volume | Size of any individual position |
| Market question, resolution source, deadline | A bettor's history across markets |
| Proof that settlement was computed correctly | The link between a wallet and a side |

Positions enter and leave as STRK20 notes. Taking a side is a private transfer
into the market's channel; a payout is a private transfer back out. The odds
move — because aggregate volume per side is public — but no observer can
attribute any part of that movement to a particular person.

Settlement stays verifiable. The market resolves against a declared source, and
the payout computation is provable without exposing the position set that it
paid out to.

## Architecture

```
                         PUBLIC                         PRIVATE
  ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
  │  Market registry                 │   │  STRK20 privacy pool             │
  │  · question, deadline, source    │   │  · position notes (UTXO)         │
  │  · aggregate YES / NO volume     │   │  · nullifiers on spend           │
  │  · derived odds                  │   │  · viewing-key encrypted         │
  │  · resolution + settlement proof │   │                                  │
  └──────────────────────────────────┘   └──────────────────────────────────┘
                    ▲                                     ▲
                    │  aggregate only                     │  per-position
                    └──────────────┬──────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │   Next.js app   │
                          │  wallet picker  │
                          │  shield / bet   │
                          │  claim / exit   │
                          └─────────────────┘
```

**Bet flow**

1. **Register** a viewing key with the pool (one time, required before a user
   can receive notes).
2. **Shield** STRK into the pool — this leg is public by design; it shows a
   deposit, not an opinion.
3. **Take a side** via a private transfer into the market channel. Aggregate
   volume for that side increments; the sender does not appear.
4. **Settle** after resolution. Winners claim via private transfer out; they
   **unshield** whenever they want the funds public, which decouples the payout
   from the bet in both time and amount.

The separation in step 3–4 is what breaks linkability: the public record shows a
deposit at one time and a withdrawal at another, with no on-chain edge between
them.

## Stack

- **Next.js 16** · React 19 · TypeScript
- **starknet.js 10.4** with get-starknet v6 wallet discovery
- **`@starkware-libs/starknet-privacy-sdk`** for shield / private transfer / unshield
- **Cairo** helper contract for the market registry and settlement
- Starknet **mainnet** (`SN_MAIN`)

Scaffolded from the [strk20-starter-kit](https://github.com/Akashneelesh/strk20-starter-kit).

## STRK20 pool

```
0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
```

## Getting started

Requires **Node.js ≥ 24** and a privacy-enabled Starknet wallet (Ready recommended).

```bash
npm install
cp .env.example .env.local   # then paste your Alchemy key
npm run dev
```

Open http://localhost:3000.

Get a free Starknet RPC key at [alchemy.com](https://www.alchemy.com). It lives in
`.env.local`, which is gitignored — the key is never committed.

## Status

Early. The wallet picker and the shield / unshield / private-transfer paths come
from the starter kit and work against mainnet. The market registry, odds
derivation and settlement are in progress.

Progress is read from this repository every 30 minutes; `strk20.json` carries the
mainnet transactions, deployed contracts and demo links as they come to exist.

## Builder

[@frankolien](https://github.com/frankolien) · Telegram `Frank_olien`

## License

MIT
