// Acceptance tests for the Blindpool contract.
//
// THESE ARE THE DEFINITION OF DONE. Every test here fails today because the contract
// bodies panic with TODO_*. When `snforge test` is green, the contract satisfies every
// invariant that spec/Blindpool.tla model-checks, plus the guards TLC cannot express
// (caller authorization, denomination discipline, commitment binding).
//
// Mapping to the formal spec:
//   test_commit_does_not_move_volume      -> EpochMonotonic   (the privacy property)
//   test_conservation_over_many_bettors   -> Conservation
//   test_double_claim_rejected            -> NoDoubleClaim
//   test_claim_before_resolve_rejected    -> NoEarlyClaim
//   test_reveal_wrong_side_rejected       -> RevealBinding
//   test_unrevealed_commit_forfeits       -> NoForfeitDrift

use core::poseidon::poseidon_hash_span;
use starknet::{ContractAddress, contract_address_const};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use blindpool::interfaces::{
    IBlindpoolDispatcher, IBlindpoolDispatcherTrait, IBlindpoolSafeDispatcher,
    IBlindpoolSafeDispatcherTrait, op, side, status,
};

const EPOCH_DURATION: u64 = 3600;
const REVEAL_WINDOW: u64 = 900;
const T0: u64 = 1_000_000;

fn pool() -> ContractAddress {
    contract_address_const::<'POOL'>()
}
fn admin() -> ContractAddress {
    contract_address_const::<'ADMIN'>()
}
fn token() -> ContractAddress {
    contract_address_const::<'TOKEN'>()
}
fn stranger() -> ContractAddress {
    contract_address_const::<'STRANGER'>()
}

/// 10 STRK — the smallest allowed tranche.
fn tranche() -> u256 {
    10_000000000000000000_u256
}
/// Not a tranche. Must be rejected on-chain, not only in the UI.
fn odd_amount() -> u256 {
    4317_000000000000000000_u256
}

/// Poseidon(side, nonce, secret) — must match computeCommitment() in
/// src/lib/blindpool/epoch.ts exactly, or the dapp and the contract disagree about
/// what a position is.
fn commitment_of(s: u8, nonce: felt252, secret: felt252) -> felt252 {
    poseidon_hash_span(array![s.into(), nonce, secret].span())
}

fn bet_payload(market_id: u64, epoch: u32, commitment: felt252, denom: u256) -> Span<felt252> {
    array![
        op::BET, market_id.into(), epoch.into(), commitment, denom.low.into(), denom.high.into(),
    ]
        .span()
}

fn reveal_payload(
    market_id: u64, commitment: felt252, s: u8, nonce: felt252, secret: felt252,
) -> Span<felt252> {
    array![op::REVEAL, market_id.into(), commitment, s.into(), nonce, secret].span()
}

fn claim_payload(
    market_id: u64, commitment: felt252, s: u8, nonce: felt252, secret: felt252,
) -> Span<felt252> {
    array![op::CLAIM, market_id.into(), commitment, s.into(), nonce, secret].span()
}

fn deploy() -> IBlindpoolDispatcher {
    let contract = declare("Blindpool").unwrap().contract_class();
    let mut calldata = ArrayTrait::new();
    Serde::serialize(@pool(), ref calldata);
    Serde::serialize(@admin(), ref calldata);
    Serde::serialize(@token(), ref calldata);
    let (contract_address, _) = contract.deploy(@calldata).unwrap();
    start_cheat_block_timestamp(contract_address, T0);
    IBlindpoolDispatcher { contract_address }
}

fn safe(d: IBlindpoolDispatcher) -> IBlindpoolSafeDispatcher {
    IBlindpoolSafeDispatcher { contract_address: d.contract_address }
}

fn new_market(d: IBlindpoolDispatcher) -> u64 {
    start_cheat_caller_address(d.contract_address, admin());
    let id = d.create_market('QUESTION', 'SOURCE', EPOCH_DURATION, REVEAL_WINDOW, 2);
    stop_cheat_caller_address(d.contract_address);
    id
}

/// Place a bet as the pool would. `note_id` is 0 — a bet requests no open note.
fn place_bet(d: IBlindpoolDispatcher, id: u64, epoch: u32, c: felt252, denom: u256) {
    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 0, bet_payload(id, epoch, c, denom));
    stop_cheat_caller_address(d.contract_address);
}

// ─── Cross-language agreement ───────────────────────────────────────────────

#[test]
fn test_commitment_matches_typescript() {
    // The one bug that would be catastrophic and invisible: if Cairo's Poseidon and the
    // dapp's disagree, every reveal fails on a live market and every stake forfeits.
    //
    // Reference value produced by computeCommitment() in src/lib/blindpool/epoch.ts for
    // side=YES(1), nonce=11, secret=22. This test passes today — it does not depend on
    // the contract bodies — and it must keep passing.
    let expected = 0x4ab9644edc88dfc8bd1fefbdd36caae28591b7a91568ed50b77265d71babaf4;
    assert(commitment_of(side::YES, 11, 22) == expected, 'TS/Cairo poseidon mismatch');
}

// ─── Market lifecycle ───────────────────────────────────────────────────────

#[test]
fn test_create_market_starts_open() {
    let d = deploy();
    let id = new_market(d);
    let m = d.get_market(id);
    assert(m.status == status::OPEN, 'market should be OPEN');
    assert(m.outcome == 0, 'outcome should be unset');
    assert(m.epoch_duration == EPOCH_DURATION, 'wrong epoch duration');
}

#[test]
#[feature("safe_dispatcher")]
fn test_only_admin_creates_markets() {
    let d = deploy();
    start_cheat_caller_address(d.contract_address, stranger());
    match safe(d).create_market('Q', 'S', EPOCH_DURATION, REVEAL_WINDOW, 2) {
        Result::Ok(_) => core::panic_with_felt252('stranger created a market'),
        Result::Err(e) => assert(*e.at(0) == 'NOT_ADMIN', *e.at(0)),
    };
}

// ─── The privacy property ───────────────────────────────────────────────────

#[test]
fn test_commit_does_not_move_volume() {
    // EpochMonotonic. If a commit moves published volume, running odds become computable
    // mid-epoch and Blindpool's entire claim collapses. The most important test here.
    let d = deploy();
    let id = new_market(d);

    let yes_before = d.get_volume(id, 0, side::YES);
    let no_before = d.get_volume(id, 0, side::NO);

    place_bet(d, id, 0, commitment_of(side::YES, 11, 22), tranche());

    assert(d.get_volume(id, 0, side::YES) == yes_before, 'commit moved YES volume');
    assert(d.get_volume(id, 0, side::NO) == no_before, 'commit moved NO volume');
}

#[test]
fn test_commit_count_tracks_anonymity_set() {
    // The k the UI shows must come from the same public data an observer has.
    let d = deploy();
    let id = new_market(d);
    assert(d.get_commit_count(id, 0, tranche()) == 0, 'should start empty');

    place_bet(d, id, 0, commitment_of(side::YES, 11, 22), tranche());
    assert(d.get_commit_count(id, 0, tranche()) == 1, 'count should be 1');

    place_bet(d, id, 0, commitment_of(side::NO, 33, 44), tranche());
    assert(d.get_commit_count(id, 0, tranche()) == 2, 'count should be 2');
}

// ─── Authorization ──────────────────────────────────────────────────────────

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_rejects_non_pool_caller() {
    // Without this the bettor's own address is the caller of record and there is no
    // privacy at all — the most consequential single assertion in the contract.
    let d = deploy();
    let id = new_market(d);
    start_cheat_caller_address(d.contract_address, stranger());
    let p = bet_payload(id, 0, commitment_of(side::YES, 1, 2), tranche());
    match safe(d).privacy_invoke(token(), pool(), 0, p) {
        Result::Ok(_) => core::panic_with_felt252('non-pool caller accepted'),
        Result::Err(e) => assert(*e.at(0) == 'NOT_POOL', *e.at(0)),
    };
}

// ─── Denomination discipline ────────────────────────────────────────────────

#[test]
#[feature("safe_dispatcher")]
fn test_non_standard_denomination_rejected() {
    // One arbitrary-amount bet correlates with the public shield leg and fingerprints its
    // bettor permanently (spec/THREAT_MODEL.md §4.4). Enforced on-chain, not only in UI.
    let d = deploy();
    let id = new_market(d);
    start_cheat_caller_address(d.contract_address, pool());
    let p = bet_payload(id, 0, commitment_of(side::YES, 1, 2), odd_amount());
    match safe(d).privacy_invoke(token(), pool(), 0, p) {
        Result::Ok(_) => core::panic_with_felt252('odd denomination accepted'),
        Result::Err(e) => assert(*e.at(0) == 'BAD_DENOM', *e.at(0)),
    };
}

// ─── Commitment binding ─────────────────────────────────────────────────────

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_wrong_side_rejected() {
    // RevealBinding. A weak check here lets a bettor switch sides after seeing the
    // aggregate, which is the one cheat the whole mechanism exists to prevent.
    let d = deploy();
    let id = new_market(d);
    let c = commitment_of(side::YES, 11, 22);
    place_bet(d, id, 0, c, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + 1);
    start_cheat_caller_address(d.contract_address, pool());
    // Same nonce and secret, but claiming NO against a commitment made for YES.
    match safe(d).privacy_invoke(token(), pool(), 0, reveal_payload(id, c, side::NO, 11, 22)) {
        Result::Ok(_) => core::panic_with_felt252('bad reveal accepted'),
        Result::Err(e) => assert(*e.at(0) == 'BAD_REVEAL', *e.at(0)),
    };
}

#[test]
fn test_reveal_correct_side_moves_volume() {
    // The other half of RevealBinding: a correct opening must be accepted, and the
    // aggregate moves only now — never at commit time.
    let d = deploy();
    let id = new_market(d);
    let c = commitment_of(side::YES, 11, 22);
    place_bet(d, id, 0, c, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + 1);
    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c, side::YES, 11, 22));
    stop_cheat_caller_address(d.contract_address);

    assert(d.get_volume(id, 0, side::YES) == tranche(), 'YES volume should move');
    assert(d.get_volume(id, 0, side::NO) == 0, 'NO volume should not move');
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_after_window_rejected() {
    let d = deploy();
    let id = new_market(d);
    let c = commitment_of(side::YES, 11, 22);
    place_bet(d, id, 0, c, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + REVEAL_WINDOW + 1);
    start_cheat_caller_address(d.contract_address, pool());
    match safe(d).privacy_invoke(token(), pool(), 0, reveal_payload(id, c, side::YES, 11, 22)) {
        Result::Ok(_) => core::panic_with_felt252('late reveal accepted'),
        Result::Err(e) => assert(*e.at(0) == 'WINDOW_CLOSED', *e.at(0)),
    };
}

#[test]
fn test_unrevealed_commit_forfeits() {
    // NoForfeitDrift: every stake ends revealed or forfeited, never neither.
    let d = deploy();
    let id = new_market(d);
    place_bet(d, id, 0, commitment_of(side::YES, 11, 22), tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + REVEAL_WINDOW + 1);
    start_cheat_caller_address(d.contract_address, admin());
    d.settle_epoch(id, 0);
    stop_cheat_caller_address(d.contract_address);

    assert(d.get_market(id).forfeited == tranche(), 'stake should be forfeited');
}

// ─── Settlement ─────────────────────────────────────────────────────────────

#[test]
#[feature("safe_dispatcher")]
fn test_claim_before_resolve_rejected() {
    // NoEarlyClaim.
    let d = deploy();
    let id = new_market(d);
    let c = commitment_of(side::YES, 11, 22);
    place_bet(d, id, 0, c, tranche());

    start_cheat_caller_address(d.contract_address, pool());
    match safe(d).privacy_invoke(token(), pool(), 1, claim_payload(id, c, side::YES, 11, 22)) {
        Result::Ok(_) => core::panic_with_felt252('early claim accepted'),
        Result::Err(e) => assert(*e.at(0) == 'NOT_RESOLVED', *e.at(0)),
    };
}

#[test]
#[feature("safe_dispatcher")]
fn test_double_claim_rejected() {
    // NoDoubleClaim — nullifier soundness. The second claim must fail.
    let d = deploy();
    let id = new_market(d);
    let c = commitment_of(side::YES, 11, 22);
    place_bet(d, id, 0, c, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + 1);
    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c, side::YES, 11, 22));
    stop_cheat_caller_address(d.contract_address);

    start_cheat_block_timestamp(d.contract_address, T0 + 2 * (EPOCH_DURATION + REVEAL_WINDOW));
    start_cheat_caller_address(d.contract_address, admin());
    d.settle_epoch(id, 0);
    d.resolve(id, side::YES);
    stop_cheat_caller_address(d.contract_address);

    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 1, claim_payload(id, c, side::YES, 11, 22));
    match safe(d).privacy_invoke(token(), pool(), 2, claim_payload(id, c, side::YES, 11, 22)) {
        Result::Ok(_) => core::panic_with_felt252('double claim accepted'),
        Result::Err(e) => assert(*e.at(0) == 'ALREADY_CLAIMED', *e.at(0)),
    };
}

#[test]
fn test_conservation_over_many_bettors() {
    // Conservation: every staked token ends up in exactly one bucket. Floored parimutuel
    // shares are what make this hold — rounding up silently drains the contract.
    let d = deploy();
    let id = new_market(d);

    // Three reveal YES, one reveals NO, one never reveals and forfeits.
    let c0 = commitment_of(side::YES, 1, 101);
    let c1 = commitment_of(side::YES, 2, 102);
    let c2 = commitment_of(side::YES, 3, 103);
    let c3 = commitment_of(side::NO, 4, 104);
    let c4 = commitment_of(side::NO, 5, 105);
    place_bet(d, id, 0, c0, tranche());
    place_bet(d, id, 0, c1, tranche());
    place_bet(d, id, 0, c2, tranche());
    place_bet(d, id, 0, c3, tranche());
    place_bet(d, id, 0, c4, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + 1);
    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c0, side::YES, 1, 101));
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c1, side::YES, 2, 102));
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c2, side::YES, 3, 103));
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c3, side::NO, 4, 104));
    // c4 never reveals.
    stop_cheat_caller_address(d.contract_address);

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + REVEAL_WINDOW + 1);
    start_cheat_caller_address(d.contract_address, admin());
    d.settle_epoch(id, 0);
    stop_cheat_caller_address(d.contract_address);

    let staked = tranche() * 5;
    let yes = d.get_volume(id, 0, side::YES);
    let no = d.get_volume(id, 0, side::NO);
    let forfeited = d.get_market(id).forfeited;
    assert(yes == tranche() * 3, 'YES should be 3 tranches');
    assert(no == tranche(), 'NO should be 1 tranche');
    assert(forfeited == tranche(), 'forfeited should be 1 tranche');
    assert(yes + no + forfeited == staked, 'stakes must be accounted');
}

#[test]
fn test_payout_never_exceeds_pool() {
    // The executable form of Conservation on the payout arithmetic itself.
    let d = deploy();
    let id = new_market(d);
    let c0 = commitment_of(side::YES, 1, 101);
    let c1 = commitment_of(side::NO, 2, 102);
    place_bet(d, id, 0, c0, tranche());
    place_bet(d, id, 0, c1, tranche());

    start_cheat_block_timestamp(d.contract_address, T0 + EPOCH_DURATION + 1);
    start_cheat_caller_address(d.contract_address, pool());
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c0, side::YES, 1, 101));
    d.privacy_invoke(token(), pool(), 0, reveal_payload(id, c1, side::NO, 2, 102));
    stop_cheat_caller_address(d.contract_address);

    start_cheat_block_timestamp(d.contract_address, T0 + 2 * (EPOCH_DURATION + REVEAL_WINDOW));
    start_cheat_caller_address(d.contract_address, admin());
    d.settle_epoch(id, 0);
    d.resolve(id, side::YES);
    stop_cheat_caller_address(d.contract_address);

    // Sole winner of a two-tranche pot takes both, and not a wei more.
    assert(d.payout_for(id, c0) == tranche() * 2, 'winner takes the pot');
}
