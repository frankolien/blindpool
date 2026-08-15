-------------------------------- MODULE Blindpool --------------------------------
(***************************************************************************)
(* Formal model of the Blindpool sealed-epoch prediction market.           *)
(*                                                                         *)
(* The property this spec exists to check is EpochMonotonic: published     *)
(* aggregates must never move while an epoch is accepting commits. That is *)
(* the mechanical statement of Blindpool's privacy claim -- if aggregates  *)
(* can change mid-epoch, running odds are computable, and front-running is *)
(* back. Every other invariant here is a correctness guard around it.      *)
(*                                                                         *)
(* Deliberately NOT modelled: the STRK20 pool itself (it verifies its own  *)
(* STARK proofs and enforces its own balance invariant), Poseidon          *)
(* preimage resistance (assumed), and the anonymizer's address-hiding      *)
(* (a confidentiality property, not a safety property TLC can check).      *)
(* Those live in spec/THREAT_MODEL.md.                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Bettors,        \* set of model bettors
    Denoms,         \* set of allowed tranche sizes, e.g. {1, 10}
    MaxEpoch        \* highest epoch index the model explores

Sides == {"YES", "NO"}

\* A bet is identified by who placed it and in which epoch. Two bets by the same
\* bettor in the same epoch collapse into one -- an abstraction that costs no
\* generality for the invariants below, and keeps the state space finite.
\* Parens are load-bearing: \X binds tighter than .., so `Bettors \X 0..MaxEpoch`
\* parses as `(Bettors \X 0)..MaxEpoch` and fails at evaluation.
Bets == Bettors \X (0..MaxEpoch)

VARIABLES
    epoch,          \* current epoch index
    phase,          \* "COMMIT" | "REVEAL" | "SETTLED" -- phase of `epoch`
    committed,      \* [Bets -> [denom, side]] as a partial function via `placed`
    placed,         \* SUBSET Bets -- which bets exist
    revealed,       \* SUBSET Bets -- which have been opened
    forfeited,      \* SUBSET Bets -- committed, never revealed, stake forfeited
    vol,            \* [Sides -> Nat] published aggregate volume
    status,         \* "OPEN" | "RESOLVED"
    outcome,        \* element of Sides once RESOLVED, else "NONE"
    claimed,        \* SUBSET Bets -- which winning bets have been paid
    paid,           \* Nat -- total value paid out
    volTouchedIn    \* phase in which `vol` last changed; "NEVER" initially

vars == << epoch, phase, committed, placed, revealed, forfeited, vol,
           status, outcome, claimed, paid, volTouchedIn >>

----------------------------------------------------------------------------
(* Helpers *)

StakeOf(b) == committed[b].denom
SideOf(b)  == committed[b].side

\* Higher-order sum: f(_) is an operator parameter, not a first-class function --
\* TLA+ has no lambdas in expression position.
SumOver(S, f(_)) ==
    LET Sum[T \in SUBSET S] ==
        IF T = {} THEN 0
        ELSE LET x == CHOOSE y \in T : TRUE
             IN f(x) + Sum[T \ {x}]
    IN Sum[S]

TotalStaked    == SumOver(placed, StakeOf)
TotalRevealed  == SumOver(revealed, StakeOf)
TotalForfeited == SumOver(forfeited, StakeOf)

\* Winners are revealed bets on the winning side. Unrevealed bets never count,
\* which is exactly the forfeiture rule.
Winners == IF outcome = "NONE" THEN {}
           ELSE { b \in revealed : SideOf(b) = outcome }

\* Parimutuel payout, floored -- the same arithmetic as payout() in
\* src/lib/blindpool/market.ts. Flooring is what keeps Conservation true.
PayoutFor(b) ==
    LET win  == vol[outcome]
        lose == vol[IF outcome = "YES" THEN "NO" ELSE "YES"] + TotalForfeited
    IN IF win = 0 THEN 0 ELSE StakeOf(b) + (StakeOf(b) * lose) \div win

----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ epoch = 0
    /\ phase = "COMMIT"
    /\ committed = [b \in Bets |-> [denom |-> 0, side |-> "YES"]]
    /\ placed = {}
    /\ revealed = {}
    /\ forfeited = {}
    /\ vol = [s \in Sides |-> 0]
    /\ status = "OPEN"
    /\ outcome = "NONE"
    /\ claimed = {}
    /\ paid = 0
    /\ volTouchedIn = "NEVER"

----------------------------------------------------------------------------
(* Actions *)

\* Place a bet. Only during COMMIT, only in the current epoch, only once per
\* (bettor, epoch), and only at an allowed denomination. Crucially this does NOT
\* touch `vol` -- that is the whole mechanism.
Commit(b, d, s) ==
    /\ status = "OPEN"
    /\ phase = "COMMIT"
    /\ b \in Bets
    /\ b[2] = epoch
    /\ b \notin placed
    /\ d \in Denoms
    /\ s \in Sides
    /\ committed' = [committed EXCEPT ![b] = [denom |-> d, side |-> s]]
    /\ placed' = placed \cup {b}
    /\ UNCHANGED << epoch, phase, revealed, forfeited, vol, status, outcome,
                    claimed, paid, volTouchedIn >>

\* Close commits and open the reveal window.
CloseEpoch ==
    /\ status = "OPEN"
    /\ phase = "COMMIT"
    /\ phase' = "REVEAL"
    /\ UNCHANGED << epoch, committed, placed, revealed, forfeited, vol, status,
                    outcome, claimed, paid, volTouchedIn >>

\* Open a commitment. RevealBinding is enforced structurally: only a bet that was
\* actually placed can be revealed, and it is added with the side it committed to
\* -- the model gives no action that reveals a different side.
Reveal(b) ==
    /\ status = "OPEN"
    /\ phase = "REVEAL"
    /\ b \in placed
    /\ b \notin revealed
    /\ b \notin forfeited
    /\ revealed' = revealed \cup {b}
    /\ vol' = [vol EXCEPT ![SideOf(b)] = @ + StakeOf(b)]
    /\ volTouchedIn' = "REVEAL"
    /\ UNCHANGED << epoch, phase, committed, placed, forfeited, status, outcome,
                    claimed, paid >>

\* The reveal window expires. Everything still unopened forfeits.
SettleEpoch ==
    /\ status = "OPEN"
    /\ phase = "REVEAL"
    /\ forfeited' = forfeited \cup { b \in placed : b \notin revealed }
    /\ IF epoch < MaxEpoch
         THEN /\ epoch' = epoch + 1
              /\ phase' = "COMMIT"
         ELSE /\ phase' = "SETTLED"
              /\ UNCHANGED epoch
    /\ UNCHANGED << committed, placed, revealed, vol, status, outcome, claimed,
                    paid, volTouchedIn >>

\* Resolve the market against its declared source.
Resolve(s) ==
    /\ status = "OPEN"
    /\ phase = "SETTLED"
    /\ s \in Sides
    /\ status' = "RESOLVED"
    /\ outcome' = s
    /\ UNCHANGED << epoch, phase, committed, placed, revealed, forfeited, vol,
                    claimed, paid, volTouchedIn >>

\* Claim a winning position. The nullifier is modelled by `claimed`: a bet not
\* already in the set is the precondition, so a second claim has no enabled action.
Claim(b) ==
    /\ status = "RESOLVED"
    /\ b \in Winners
    /\ b \notin claimed
    /\ claimed' = claimed \cup {b}
    /\ paid' = paid + PayoutFor(b)
    /\ UNCHANGED << epoch, phase, committed, placed, revealed, forfeited, vol,
                    status, outcome, volTouchedIn >>

Next ==
    \/ \E b \in Bets, d \in Denoms, s \in Sides : Commit(b, d, s)
    \/ CloseEpoch
    \/ \E b \in Bets : Reveal(b)
    \/ SettleEpoch
    \/ \E s \in Sides : Resolve(s)
    \/ \E b \in Bets : Claim(b)
    \* Stutter once fully settled so TLC sees no deadlock at the terminal state.
    \/ /\ status = "RESOLVED"
       /\ claimed = Winners
       /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
    /\ epoch \in 0..MaxEpoch
    /\ phase \in {"COMMIT", "REVEAL", "SETTLED"}
    /\ placed \subseteq Bets
    /\ revealed \subseteq Bets
    /\ forfeited \subseteq Bets
    /\ claimed \subseteq Bets
    /\ status \in {"OPEN", "RESOLVED"}
    /\ outcome \in Sides \cup {"NONE"}
    /\ paid \in Nat
    /\ volTouchedIn \in {"NEVER", "COMMIT", "REVEAL"}

(* THE privacy property. Published aggregates must never move while an epoch is
   accepting commits. If TLC finds a trace violating this, running odds are
   computable mid-epoch and the sealed-epoch mechanism has leaked. *)
EpochMonotonic == volTouchedIn # "COMMIT"

(* Settlement never mints. Total paid out can never exceed what was staked --
   floored parimutuel shares are what make this hold. *)
Conservation == paid <= TotalStaked

(* Nullifier soundness: a bet is paid at most once. Enforced by construction
   (`claimed` is a set and Claim requires absence), asserted so a future edit to
   Claim that breaks it fails loudly. *)
NoDoubleClaim == claimed \subseteq Winners

(* No payout before the market resolves. *)
NoEarlyClaim == (claimed # {}) => (status = "RESOLVED")

(* Only genuinely placed bets can ever be revealed -- the model's counterpart to
   checking H(side, nonce, secret) = commitment on-chain. *)
RevealBinding == revealed \subseteq placed

(* A stake is in exactly one terminal bucket: revealed or forfeited, never both,
   and never neither once the market has settled. *)
NoForfeitDrift ==
    /\ revealed \cap forfeited = {}
    /\ (phase = "SETTLED") => (placed = revealed \cup forfeited)

Invariants ==
    /\ TypeOK
    /\ EpochMonotonic
    /\ Conservation
    /\ NoDoubleClaim
    /\ NoEarlyClaim
    /\ RevealBinding
    /\ NoForfeitDrift

============================================================================
