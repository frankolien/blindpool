// ┌──────────────────────────────────────────────────────────────────────────────┐
// │  STUB — the bodies in this file are yours to write.                          │
// │                                                                              │
// │  This is deliberate. This contract custodies stakes and computes settlement;  │
// │  generated on-chain code that nobody reviewed is worse than none, because it  │
// │  looks finished. The structure, storage layout and interface are transcribed  │
// │  from spec/CONTRACTS.md; the logic is not.                                    │
// │                                                                              │
// │  Definition of done: `snforge test` goes green. The 12 tests in               │
// │  tests/test_blindpool.cairo are the acceptance criteria, and they encode      │
// │  every invariant that spec/Blindpool.tla model-checks.                        │
// │                                                                              │
// │  Read echo.cairo first — it is a working privacy_invoke against the live      │
// │  pool and answers most of the mechanical questions.                           │
// └──────────────────────────────────────────────────────────────────────────────┘

#[starknet::contract]
pub mod Blindpool {
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use crate::interfaces::{Commit, Market, OpenNoteDeposit};

    pub mod errors {
        /// The caller was not the configured privacy pool. Without this assertion the
        /// bettor's own address becomes the caller of record and there is no privacy.
        pub const NOT_POOL: felt252 = 'NOT_POOL';
        pub const NOT_ADMIN: felt252 = 'NOT_ADMIN';
        pub const BAD_OP: felt252 = 'BAD_OP';
        pub const BAD_SIDE: felt252 = 'BAD_SIDE';
        /// Amount outside the fixed tranche set. Belongs on-chain, not only in the UI:
        /// one arbitrary-amount bet fingerprints its bettor permanently.
        pub const BAD_DENOM: felt252 = 'BAD_DENOM';
        pub const MARKET_CLOSED: felt252 = 'MARKET_CLOSED';
        pub const NOT_RESOLVED: felt252 = 'NOT_RESOLVED';
        pub const COMMIT_EXISTS: felt252 = 'COMMIT_EXISTS';
        pub const NO_COMMIT: felt252 = 'NO_COMMIT';
        /// Reveal did not hash to the stored commitment. If this check is weak, a bettor
        /// can switch sides after seeing the aggregate and the mechanism is dead.
        pub const BAD_REVEAL: felt252 = 'BAD_REVEAL';
        pub const WINDOW_CLOSED: felt252 = 'WINDOW_CLOSED';
        pub const ALREADY_REVEALED: felt252 = 'ALREADY_REVEALED';
        pub const ALREADY_CLAIMED: felt252 = 'ALREADY_CLAIMED';
        pub const NOT_WINNER: felt252 = 'NOT_WINNER';
        pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
    }

    #[storage]
    struct Storage {
        /// Only this address may call privacy_invoke.
        pool: ContractAddress,
        admin: ContractAddress,
        token: ContractAddress,
        next_market_id: u64,
        markets: Map<u64, Market>,
        commits: Map<(u64, felt252), Commit>,
        /// (market, epoch, side) -> revealed volume.
        /// Written ONLY by reveal. A write from the bet path breaks EpochMonotonic.
        epoch_volume: Map<(u64, u32, u8), u256>,
        /// (market, epoch, denomination) -> count. Feeds the anonymity meter.
        epoch_commit_count: Map<(u64, u32, u256), u32>,
        nullifiers: Map<(u64, felt252), bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Committed: Committed,
        Revealed: Revealed,
        EpochSettled: EpochSettled,
        Resolved: Resolved,
        Claimed: Claimed,
    }

    // Indexed keys are read by src/lib/blindpool/indexer.ts. Never index a user address:
    // there is none, and adding one would undo the anonymizer.
    #[derive(Drop, starknet::Event)]
    pub struct Committed {
        #[key]
        pub market_id: u64,
        #[key]
        pub epoch: u32,
        pub commitment: felt252,
        pub denomination: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Revealed {
        #[key]
        pub market_id: u64,
        #[key]
        pub epoch: u32,
        pub commitment: felt252,
        pub side: u8,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EpochSettled {
        #[key]
        pub market_id: u64,
        #[key]
        pub epoch: u32,
        pub yes_volume: u256,
        pub no_volume: u256,
        pub forfeited: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Resolved {
        #[key]
        pub market_id: u64,
        pub outcome: u8,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Claimed {
        #[key]
        pub market_id: u64,
        pub commitment: felt252,
        pub amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        admin: ContractAddress,
        token: ContractAddress,
    ) {
        self.pool.write(pool);
        self.admin.write(admin);
        self.token.write(token);
        self.next_market_id.write(1);
    }

    #[abi(embed_v0)]
    impl BlindpoolImpl of crate::interfaces::IBlindpool<ContractState> {
        // ── TODO(you): spec/CONTRACTS.md §2 ──────────────────────────────────
        // Assert caller == pool. Read the op discriminator from the calldata tail and
        // dispatch to bet / reveal / claim. Return an empty span for BET and REVEAL;
        // return one OpenNoteDeposit for CLAIM.
        //
        // echo.cairo shows the mechanics: the pool has already sent the stake when this
        // runs (withdraw phase precedes invoke), and approving the pool is what lets it
        // pull value back to fill an open note.
        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
            payload: Span<felt252>,
        ) -> Span<OpenNoteDeposit> {
            core::panic_with_felt252('TODO_PRIVACY_INVOKE')
        }

        // ── TODO(you): spec/CONTRACTS.md §1 ──────────────────────────────────
        fn create_market(
            ref self: ContractState,
            question_hash: felt252,
            resolution_source_hash: felt252,
            epoch_duration: u64,
            reveal_window: u64,
            total_epochs: u32,
        ) -> u64 {
            core::panic_with_felt252('TODO_CREATE_MARKET')
        }

        // Sweep every unrevealed commit of this epoch into `forfeited`, then emit
        // EpochSettled. This is the ONLY point at which aggregates become public.
        fn settle_epoch(ref self: ContractState, market_id: u64, epoch: u32) {
            core::panic_with_felt252('TODO_SETTLE_EPOCH')
        }

        fn resolve(ref self: ContractState, market_id: u64, outcome: u8) {
            core::panic_with_felt252('TODO_RESOLVE')
        }

        fn get_market(self: @ContractState, market_id: u64) -> Market {
            self.markets.read(market_id)
        }

        fn get_commit(self: @ContractState, market_id: u64, commitment: felt252) -> Commit {
            self.commits.read((market_id, commitment))
        }

        fn get_volume(self: @ContractState, market_id: u64, epoch: u32, side: u8) -> u256 {
            self.epoch_volume.read((market_id, epoch, side))
        }

        fn get_commit_count(
            self: @ContractState, market_id: u64, epoch: u32, denomination: u256,
        ) -> u32 {
            self.epoch_commit_count.read((market_id, epoch, denomination))
        }

        fn is_claimed(self: @ContractState, market_id: u64, commitment: felt252) -> bool {
            self.nullifiers.read((market_id, commitment))
        }

        // ── TODO(you): parimutuel, floored. spec/CONTRACTS.md §1 ─────────────
        //   winning = Σ epoch_volume[market, *, outcome]
        //   losing  = Σ epoch_volume[market, *, other] + forfeited
        //   payout  = stake + (stake * losing) / winning
        // Integer division, and do NOT round up — flooring is what makes conservation
        // hold. The dust residue stays in the contract by design.
        fn payout_for(self: @ContractState, market_id: u64, commitment: felt252) -> u256 {
            core::panic_with_felt252('TODO_PAYOUT_FOR')
        }
    }
}
