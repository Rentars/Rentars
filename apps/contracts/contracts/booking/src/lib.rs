//! Booking Contract for Rentars
//!
//! Manages rental bookings with overlap prevention, status transitions,
//! escrow ID tracking, per-property booking indexes, and on-chain USDC escrow.
//!
//! ## Cross-Contract Integration
//!
//! `create_booking` performs two cross-contract calls against the
//! `property-listing` contract (whose address is stored at initialization):
//!
//! 1. **Verify availability** — calls `get_listing(property_id)` and asserts
//!    the returned status is `ListingStatus::Active`. Bookings on inactive or
//!    already-rented properties are rejected.
//! 2. **Mark as rented** — after persisting the booking, calls `set_rented(id)`
//!    on the property-listing contract to atomically flip the property status to
//!    `Rented`, preventing double-bookings across contract boundaries.
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
//! ledger entry expiry on Stellar's state-expiration model:
//!
//! - **TTL_MIN** (100 ledgers): Minimum remaining TTL before an extension fires.
//! - **TTL_EXTEND_TO** (100 ledgers): Target TTL applied on every write.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, String, Vec};

use property_listing::{ListingStatus, PropertyListingContractClient};

// ─── TTL Constants ────────────────────────────────────────────────────────────

const TTL_MIN: u32 = 100;
const TTL_EXTEND_TO: u32 = 100;

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

    /// Create a new booking. Verifies property availability cross-contract.
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

        assert!(
            listing.status == ListingStatus::Active,
            "Property is not available for booking"
        );

        let property_owner = listing.owner.clone();

        let property_bookings: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::PropertyBookings(property_id))
            .unwrap_or(vec![&env]);

        for i in 0..property_bookings.len() {
            let bid = property_bookings.get(i).unwrap();
            let existing: Booking = env
                .storage()
                .persistent()
                .get(&DataKey::Booking(bid))
                .unwrap();

            if existing.status == BookingStatus::Cancelled {
                continue;
            }

            let overlaps = !(check_out <= existing.check_in || check_in >= existing.check_out);
            assert!(!overlaps, "Booking dates overlap with an existing booking");
        }

        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BookingCount)
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

        env.storage().persistent().set(&DataKey::Booking(id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(id), TTL_MIN, TTL_EXTEND_TO);

        env.storage().persistent().set(&DataKey::BookingCount, &id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::BookingCount, TTL_MIN, TTL_EXTEND_TO);

        let mut bookings = property_bookings;
        bookings.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::PropertyBookings(property_id), &bookings);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::PropertyBookings(property_id), TTL_MIN, TTL_EXTEND_TO);

        listing_client.set_rented(&property_id);

        id
    }

    /// Fund the escrow for a booking by transferring tokens from tenant to contract.
    pub fn fund_escrow(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

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
        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Cancel a booking. Allowed by the tenant or the contract admin.
    ///
    /// If the escrow is funded, the full amount is refunded to the tenant.
    pub fn cancel_booking(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

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
        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
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

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

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
        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Open a dispute on a funded booking (tenant only).
    ///
    /// Only `Pending` or `Confirmed` bookings with `Funded` escrow can be disputed.
    pub fn dispute_booking(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

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
        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
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

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

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

        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
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

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

        booking.escrow_id = escrow_id;
        env.storage().persistent().set(&DataKey::Booking(booking_id), &booking);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Retrieve a booking by its on-chain ID.
    pub fn get_booking(env: Env, id: u64) -> Booking {
        env.storage()
            .persistent()
            .get(&DataKey::Booking(id))
            .expect("Booking not found")
    }

    /// Return all booking IDs for a given property.
    pub fn get_property_bookings(env: Env, property_id: u64) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::PropertyBookings(property_id))
            .unwrap_or(vec![&env])
    }

    /// Check whether a date range is available for a property.
    pub fn check_availability(
        env: Env,
        property_id: u64,
        check_in: u64,
        check_out: u64,
    ) -> bool {
        let property_bookings: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::PropertyBookings(property_id))
            .unwrap_or(vec![&env]);

        for i in 0..property_bookings.len() {
            let bid = property_bookings.get(i).unwrap();
            let existing: Booking = env
                .storage()
                .persistent()
                .get(&DataKey::Booking(bid))
                .unwrap();

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
        env.storage()
            .persistent()
            .get(&DataKey::BookingCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
