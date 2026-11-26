//! Booking Contract for Rentars
//!
//! Manages rental bookings with overlap prevention, status transitions,
//! escrow ID tracking, per-property booking indexes, and on-chain USDC escrow.
//!
//! ## Cross-Contract Integration
//!
//! `create_booking` performs a cross-contract call against the
//! `property-listing` contract (whose address is stored at initialization):
//!
//! 1. **Verify availability** — calls `get_listing(property_id)` and asserts
//!    the returned status is `ListingStatus::Active`. Bookings on inactive or
//!    removed properties are rejected.
//!
//! Properties are NOT permanently marked as `Rented` after a single booking.
//! Instead, the contract tracks all bookings per-property by date range and
//! rejects any new booking whose `[check_in, check_out)` interval overlaps an
//! existing, non-cancelled booking. This allows owners to accept sequential
//! or non-overlapping future reservations without having to manually re-activate
//! the listing after each stay.
//!
//! Owner-initiated pauses (`ListingStatus::Inactive`) and administrative
//! removals remain fully enforceable — only `Active` listings accept bookings.
//!
//! ## Escrow Flow
//!
//! 1. `create_booking` — booking starts `Pending`, `NotFunded`.
//! 2. `set_token_address` (admin) — configure the USDC token contract.
//! 3. `fund_escrow` (tenant) — transfers `total_price` tokens to this contract;
//!    booking moves to `Funded`.
//! 4. On confirm (`update_status` → `Confirmed`) — contract releases tokens to
//!    property owner; escrow moves to `Released`.
//! 5. On cancel (tenant or admin `cancel_booking`, or admin `update_status` →
//!    `Cancelled`) — if funded, tokens are returned to tenant; escrow moves to
//!    `Refunded`.
//! 6. `dispute_booking` (tenant) — opens a dispute on a funded booking.
//! 7. `resolve_dispute` (admin) — releases to owner or refunds tenant.
//!
//! ## Storage TTL Strategy
//!
//! All persistent storage entries use TTL (time-to-live) extensions to prevent
//! ledger entry expiry on Stellar's state-expiration model.
//!
//! ### Constants
//!
//! | Constant           | Ledgers    | Real-world duration          |
//! |--------------------|-----------|------------------------------|
//! | `LEDGER_THRESHOLD` |  120,960  | ~7 days  (at 5 s/ledger)    |
//! | `LEDGER_TARGET`    | 6,307,200 | ~1 year  (at 5 s/ledger)    |
//!
//! Rationale:
//! - **LEDGER_THRESHOLD**: If a persistent entry has fewer than ~7 days of TTL
//!   remaining, it is extended on the next read or write. This provides a
//!   comfortable buffer before automatic archival and avoids spurious
//!   re-extension costs during active usage.
//! - **LEDGER_TARGET**: Each extension resets the TTL to ~1 year. Booking
//!   records, property booking indexes, the global counter, and admin config
//!   all require long-lived persistence — a 1-year window matches expected
//!   platform activity and far exceeds any single rental period.
//!
//! ### Which keys are extended
//!
//! - `Booking(id)` — extended on every read and write.
//! - `BookingCount` — extended on every write.
//! - `PropertyBookings(property_id)` — extended on every read and write.
//! - `Initialized`, `Admin`, `PropertyListingContractId`, `TokenAddress` —
//!   stored in **instance** storage, which is extended automatically with the
//!   contract instance; no manual TTL calls are required for these keys.
//!
//! ### Archival note
//!
//! Entries that have not been touched within the TTL window become archived on
//! Stellar. Archived entries can be restored via a Stellar restore transaction,
//! but this requires the restorer to supply the archived entry proof. For
//! production deployments, a background job should monitor TTL and extend
//! entries proactively to avoid archival entirely.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, String, Vec};

use property_listing::{ListingStatus, PropertyListingContractClient};

// ─── TTL Constants ────────────────────────────────────────────────────────────
//
// 1 ledger ≈ 5 seconds on Stellar mainnet.
//   1 day  ≈  17,280 ledgers
//   7 days ≈ 120,960 ledgers
//   1 year ≈ 6,307,200 ledgers

/// Minimum remaining TTL (in ledgers) before an extension is triggered.
/// Approximately 7 days — provides a comfortable buffer before archival.
const LEDGER_THRESHOLD: u32 = 120_960;

/// Target TTL (in ledgers) applied on every read/write extension.
/// Approximately 1 year — matches expected platform activity and exceeds
/// any realistic single rental period.
const LEDGER_TARGET: u32 = 6_307_200;

// ─── Data Types ──────────────────────────────────────────────────────────────

/// Lifecycle status of a booking.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum BookingStatus {
    Pending,
    Confirmed,
    Cancelled,
    Completed,
    Disputed,
}

/// Escrow funding state for a booking.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    NotFunded,
    Funded,
    Released,
    Refunded,
}

/// A rental booking stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct Booking {
    pub id: u64,
    pub property_id: u64,
    pub property_owner: Address,
    pub tenant: Address,
    pub check_in: u64,
    pub check_out: u64,
    pub total_price: i128,
    pub status: BookingStatus,
    pub escrow_id: String,
    pub escrow_status: EscrowStatus,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    Initialized,
    Admin,
    PropertyListingContractId,
    TokenAddress,
    Booking(u64),
    BookingCount,
    PropertyBookings(u64),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct BookingContract;

#[contractimpl]
impl BookingContract {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Initialize the booking contract. Must be called exactly once.
    pub fn initialize(env: Env, admin: Address, property_listing_contract_id: Address) {
        admin.require_auth();

        assert!(
            !env.storage().instance().has(&DataKey::Initialized),
            "Already initialized"
        );

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PropertyListingContractId, &property_listing_contract_id);
    }

    // ── Token Management ─────────────────────────────────────────────────────

    /// Set the USDC token contract address. Admin only.
    pub fn set_token_address(env: Env, caller: Address, token_addr: Address) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        assert!(caller == admin, "Unauthorized");
        env.storage().instance().set(&DataKey::TokenAddress, &token_addr);
    }

    /// Return the configured USDC token contract address.
    pub fn get_token_address(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Token address not set")
    }

    // ── Bookings ─────────────────────────────────────────────────────────────

    /// Create a new booking. Verifies property availability via cross-contract
    /// read and rejects overlapping date ranges atomically.
    ///
    /// Unlike the previous design, the property's status is NOT changed to
    /// `Rented` after a successful booking. This allows non-overlapping future
    /// bookings to be accepted. The listing must be `Active`; `Inactive` or
    /// `Removed` listings are rejected (see Issue 112).
    ///
    /// Overlap detection: for each existing, non-cancelled booking on the same
    /// property, the contract checks whether `[check_in, check_out)` intersects
    /// the existing `[existing.check_in, existing.check_out)` interval. The
    /// check is `!(check_out <= existing.check_in || check_in >= existing.check_out)`.
    pub fn create_booking(
        env: Env,
        tenant: Address,
        property_id: u64,
        check_in: u64,
        check_out: u64,
        total_price: i128,
    ) -> u64 {
        tenant.require_auth();

        assert!(check_in < check_out, "check_in must be before check_out");
        assert!(total_price > 0, "total_price must be positive");

        let listing_contract_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::PropertyListingContractId)
            .expect("Contract not initialized");

        let listing_client = PropertyListingContractClient::new(&env, &listing_contract_id);
        let listing = listing_client.get_listing(&property_id);

        // Only Active listings accept new bookings. Paused (Inactive) or
        // removed listings are explicitly blocked here (Issue 114 alignment).
        assert!(
            listing.status == ListingStatus::Active,
            "Property is not available for booking"
        );

        let property_owner = listing.owner.clone();

        // Load the per-property booking index; default to empty on first use.
        let property_bookings_key = DataKey::PropertyBookings(property_id);
        let property_bookings: Vec<u64> = env
            .storage()
            .persistent()
            .get(&property_bookings_key)
            .unwrap_or(vec![&env]);

        // Extend TTL on the index after reading.
        if env.storage().persistent().has(&property_bookings_key) {
            env.storage()
                .persistent()
                .extend_ttl(&property_bookings_key, LEDGER_THRESHOLD, LEDGER_TARGET);
        }

        // Reject if any non-cancelled booking overlaps the requested dates.
        // This is the core of Issue 112: date-range occupancy replaces the
        // single-flag Rented status so multiple non-overlapping future
        // reservations are permitted on the same listing.
        for i in 0..property_bookings.len() {
            let bid = property_bookings.get(i).unwrap();
            let existing_key = DataKey::Booking(bid);
            let existing: Booking = env
                .storage()
                .persistent()
                .get(&existing_key)
                .unwrap();

            // Extend TTL on each booking record accessed during the scan.
            env.storage()
                .persistent()
                .extend_ttl(&existing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

            if existing.status == BookingStatus::Cancelled {
                continue;
            }

            let overlaps = !(check_out <= existing.check_in || check_in >= existing.check_out);
            assert!(!overlaps, "Booking dates overlap with an existing booking");
        }

        // Assign the next booking ID.
        let count_key = DataKey::BookingCount;
        let count: u64 = env
            .storage()
            .persistent()
            .get(&count_key)
            .unwrap_or(0);
        let id = count + 1;

        let booking = Booking {
            id,
            property_id,
            property_owner,
            tenant,
            check_in,
            check_out,
            total_price,
            status: BookingStatus::Pending,
            escrow_id: String::from_str(&env, ""),
            escrow_status: EscrowStatus::NotFunded,
        };

        // Persist booking and extend TTL immediately.
        let booking_key = DataKey::Booking(id);
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        // Update global counter and extend its TTL.
        env.storage().persistent().set(&count_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&count_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        // Append to the per-property booking index and extend its TTL.
        let mut bookings = property_bookings;
        bookings.push_back(id);
        env.storage()
            .persistent()
            .set(&property_bookings_key, &bookings);
        env.storage()
            .persistent()
            .extend_ttl(&property_bookings_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        // NOTE (Issue 112): We intentionally do NOT call listing_client.set_rented()
        // here. Marking the property as Rented after the first booking would block
        // all subsequent non-overlapping future reservations. Availability is now
        // enforced purely by date-range overlap detection above. The listing owner
        // retains control via update_status (Active ↔ Inactive) in the
        // property-listing contract.

        id
    }

    /// Fund the escrow for a booking by transferring tokens from tenant to contract.
    pub fn fund_escrow(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(
            booking.tenant == caller,
            "Unauthorized: caller is not the tenant"
        );
        assert!(
            booking.status == BookingStatus::Pending,
            "Booking must be in Pending state to fund escrow"
        );
        assert!(
            booking.escrow_status == EscrowStatus::NotFunded,
            "Escrow already funded"
        );

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Token address not set");

        let token = token::Client::new(&env, &token_addr);
        token.transfer(&caller, &env.current_contract_address(), &booking.total_price);

        booking.escrow_status = EscrowStatus::Funded;
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Cancel a booking. Allowed by the tenant or the contract admin.
    ///
    /// If the escrow is funded, the full amount is refunded to the tenant.
    pub fn cancel_booking(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        assert!(
            booking.tenant == caller || caller == admin,
            "Unauthorized"
        );
        assert!(
            booking.status != BookingStatus::Cancelled,
            "Booking already cancelled"
        );
        assert!(
            booking.status != BookingStatus::Completed,
            "Cannot cancel a completed booking"
        );
        assert!(
            booking.status != BookingStatus::Disputed,
            "Cannot cancel a disputed booking"
        );

        if booking.escrow_status == EscrowStatus::Funded {
            let token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::TokenAddress)
                .expect("Token address not set");
            let token = token::Client::new(&env, &token_addr);
            token.transfer(
                &env.current_contract_address(),
                &booking.tenant,
                &booking.total_price,
            );
            booking.escrow_status = EscrowStatus::Refunded;
        }

        booking.status = BookingStatus::Cancelled;
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Advance a booking through the defined state machine (admin only).
    ///
    /// Transition graph:
    /// ```text
    ///   Pending  ──→ Confirmed ──→ Completed
    ///     │              │
    ///     └──→ Cancelled ←──┘
    /// ```
    ///
    /// On `Confirmed`: if escrow is `Funded`, releases tokens to property owner.
    /// On `Cancelled`: if escrow is `Funded`, refunds tokens to tenant.
    pub fn update_status(
        env: Env,
        caller: Address,
        booking_id: u64,
        new_status: BookingStatus,
    ) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        assert!(caller == admin, "Unauthorized");

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        let valid = match (&booking.status, &new_status) {
            (BookingStatus::Pending, BookingStatus::Confirmed) => true,
            (BookingStatus::Pending, BookingStatus::Cancelled) => true,
            (BookingStatus::Confirmed, BookingStatus::Completed) => true,
            (BookingStatus::Confirmed, BookingStatus::Cancelled) => true,
            _ => false,
        };
        assert!(valid, "Invalid status transition");

        if new_status == BookingStatus::Confirmed
            && booking.escrow_status == EscrowStatus::Funded
        {
            let token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::TokenAddress)
                .expect("Token address not set");
            let token = token::Client::new(&env, &token_addr);
            token.transfer(
                &env.current_contract_address(),
                &booking.property_owner,
                &booking.total_price,
            );
            booking.escrow_status = EscrowStatus::Released;
        }

        if new_status == BookingStatus::Cancelled
            && booking.escrow_status == EscrowStatus::Funded
        {
            let token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::TokenAddress)
                .expect("Token address not set");
            let token = token::Client::new(&env, &token_addr);
            token.transfer(
                &env.current_contract_address(),
                &booking.tenant,
                &booking.total_price,
            );
            booking.escrow_status = EscrowStatus::Refunded;
        }

        booking.status = new_status;
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Open a dispute on a funded booking (tenant only).
    ///
    /// Only `Pending` or `Confirmed` bookings with `Funded` escrow can be disputed.
    pub fn dispute_booking(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(
            booking.tenant == caller,
            "Unauthorized: caller is not the tenant"
        );
        assert!(
            booking.escrow_status == EscrowStatus::Funded,
            "Only funded bookings can be disputed"
        );
        assert!(
            booking.status == BookingStatus::Pending
                || booking.status == BookingStatus::Confirmed,
            "Booking must be Pending or Confirmed to dispute"
        );

        booking.status = BookingStatus::Disputed;
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Resolve a disputed booking (admin only).
    ///
    /// - `release_to_owner = true`: releases escrow to property owner, status → Completed.
    /// - `release_to_owner = false`: refunds tenant, status → Cancelled.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        booking_id: u64,
        release_to_owner: bool,
    ) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        assert!(caller == admin, "Unauthorized");

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(
            booking.status == BookingStatus::Disputed,
            "Booking is not in dispute"
        );

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Token address not set");
        let token = token::Client::new(&env, &token_addr);

        if release_to_owner {
            token.transfer(
                &env.current_contract_address(),
                &booking.property_owner,
                &booking.total_price,
            );
            booking.status = BookingStatus::Completed;
            booking.escrow_status = EscrowStatus::Released;
        } else {
            token.transfer(
                &env.current_contract_address(),
                &booking.tenant,
                &booking.total_price,
            );
            booking.status = BookingStatus::Cancelled;
            booking.escrow_status = EscrowStatus::Refunded;
        }

        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Attach an off-chain escrow reference to a booking (admin only).
    pub fn set_escrow_id(env: Env, caller: Address, booking_id: u64, escrow_id: String) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        assert!(caller == admin, "Unauthorized");

        let booking_key = DataKey::Booking(booking_id);
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        booking.escrow_id = escrow_id;
        env.storage().persistent().set(&booking_key, &booking);
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Retrieve a booking by its on-chain ID.
    pub fn get_booking(env: Env, id: u64) -> Booking {
        let booking_key = DataKey::Booking(id);
        let booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .expect("Booking not found");

        // Extend TTL on read to keep active records alive.
        env.storage()
            .persistent()
            .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        booking
    }

    /// Return all booking IDs for a given property.
    pub fn get_property_bookings(env: Env, property_id: u64) -> Vec<u64> {
        let key = DataKey::PropertyBookings(property_id);
        let bookings: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(vec![&env]);

        // Extend TTL on read if the entry exists.
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_TARGET);
        }

        bookings
    }

    /// Check whether a date range is available for a property.
    pub fn check_availability(
        env: Env,
        property_id: u64,
        check_in: u64,
        check_out: u64,
    ) -> bool {
        let key = DataKey::PropertyBookings(property_id);
        let property_bookings: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(vec![&env]);

        // Extend TTL on read if the entry exists.
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_TARGET);
        }

        for i in 0..property_bookings.len() {
            let bid = property_bookings.get(i).unwrap();
            let booking_key = DataKey::Booking(bid);
            let existing: Booking = env
                .storage()
                .persistent()
                .get(&booking_key)
                .unwrap();

            // Extend TTL on each booking accessed during the scan.
            env.storage()
                .persistent()
                .extend_ttl(&booking_key, LEDGER_THRESHOLD, LEDGER_TARGET);

            if existing.status == BookingStatus::Cancelled {
                continue;
            }

            let overlaps = !(check_out <= existing.check_in || check_in >= existing.check_out);
            if overlaps {
                return false;
            }
        }
        true
    }

    /// Return the total number of bookings ever created.
    pub fn booking_count(env: Env) -> u64 {
        let key = DataKey::BookingCount;
        let count: u64 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(0);

        // Extend TTL on read if the counter entry exists.
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_TARGET);
        }

        count
    }
}

#[cfg(test)]
mod test;
