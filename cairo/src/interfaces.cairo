// Blindpool interfaces and shared types.
//
// Transcribed from spec/CONTRACTS.md — types and signatures only, no logic. Changing a
// signature here means changing the spec and the TypeScript composition in
// src/lib/blindpool/bet.ts, which encodes the calldata layout.

use starknet::ContractAddress;

/// Must match `privacy::objects::OpenNoteDeposit` (positional Serde).
/// Verified against the working echo helper in `echo.cairo`.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

/// Operation discriminator, first element of the Blindpool calldata tail.
/// Mirrors `OP` in `src/lib/blindpool/bet.ts` — keep the two in step.
pub mod op {
    pub const BET: felt252 = 1;
    pub const REVEAL: felt252 = 2;
    pub const CLAIM: felt252 = 3;
}

/// Side encoding. Never 0 — an uninitialised storage slot reads as 0, and that must not
/// be mistakable for a valid side. Mirrors `SIDE_FELT` in `epoch.ts`.
pub mod side {
    pub const YES: u8 = 1;
    pub const NO: u8 = 2;
}

pub mod status {
    pub const OPEN: u8 = 0;
    pub const CLOSED: u8 = 1;
    pub const RESOLVED: u8 = 2;
}

#[derive(Drop, Serde, Copy, starknet::Store)]
pub struct Market {
    pub question_hash: felt252,
    pub resolution_source_hash: felt252,
    pub started_at: u64,
    pub epoch_duration: u64,
    pub reveal_window: u64,
    pub total_epochs: u32,
    pub status: u8,
    pub outcome: u8,
    /// Stakes committed but never revealed; added to the winning pot at settlement.
    pub forfeited: u256,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
pub struct Commit {
    pub epoch: u32,
    pub denomination: u256,
    /// 0 until revealed.
    pub revealed_side: u8,
    pub stake_settled: bool,
}

#[starknet::interface]
pub trait IBlindpool<TState> {
    /// Called by the privacy pool via `selector!("privacy_invoke")`.
    ///
    /// The pool forwards the dapp's calldata array positionally as this entrypoint's
    /// arguments, so the signature *is* the calldata layout. A Cairo entrypoint has one
    /// fixed arity, but a BET carries different parameters than a CLAIM — hence the
    /// trailing `payload` span, which Serde encodes as `[len, ...items]`.
    ///
    /// Calldata from `src/lib/blindpool/bet.ts`:
    ///   [token, ${poolAddress}, note_id, payload_len, ...payload]
    ///
    /// `note_id` is `0` for BET and REVEAL, which request no open note. For CLAIM it is
    /// the `${openNoteIds[0]}` placeholder the wallet substitutes.
    ///
    /// Payload layouts (payload[0] is always the op discriminator):
    ///   BET    [OP_BET,    market_id, epoch, commitment, denom_lo, denom_hi]
    ///   REVEAL [OP_REVEAL, market_id, commitment, side, nonce, secret]
    ///   CLAIM  [OP_CLAIM,  market_id, commitment, side, nonce, secret]
    ///
    /// Return an empty span for BET and REVEAL (nothing is credited back) and a single
    /// `OpenNoteDeposit` for CLAIM (the payout fills the open note).
    fn privacy_invoke(
        ref self: TState,
        token: ContractAddress,
        pool_address: ContractAddress,
        note_id: felt252,
        payload: Span<felt252>,
    ) -> Span<OpenNoteDeposit>;

    // ─── Admin ──────────────────────────────────────────────────────────────
    fn create_market(
        ref self: TState,
        question_hash: felt252,
        resolution_source_hash: felt252,
        epoch_duration: u64,
        reveal_window: u64,
        total_epochs: u32,
    ) -> u64;
    fn settle_epoch(ref self: TState, market_id: u64, epoch: u32);
    fn resolve(ref self: TState, market_id: u64, outcome: u8);

    // ─── Views ──────────────────────────────────────────────────────────────
    fn get_market(self: @TState, market_id: u64) -> Market;
    fn get_commit(self: @TState, market_id: u64, commitment: felt252) -> Commit;
    /// Revealed volume for a side. MUST stay unchanged by a commit — this is the
    /// `EpochMonotonic` invariant from spec/Blindpool.tla.
    fn get_volume(self: @TState, market_id: u64, epoch: u32, side: u8) -> u256;
    /// Commit count per (epoch, denomination) — the k of the anonymity meter.
    fn get_commit_count(self: @TState, market_id: u64, epoch: u32, denomination: u256) -> u32;
    fn is_claimed(self: @TState, market_id: u64, commitment: felt252) -> bool;
    fn payout_for(self: @TState, market_id: u64, commitment: felt252) -> u256;
}

#[starknet::interface]
pub trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
}
