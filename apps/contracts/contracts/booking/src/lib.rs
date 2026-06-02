//! Booking Contract for Rentars
//!
//! Manages rental bookings with overlap prevention, status transitions,
//! escrow ID tracking, and per-property booking indexes.
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
//! ## Storage TTL Strategy
//!
//! All persistent storage entries use TTL (time-to-live) extensions to prevent
//! ledger entry expiry on Stellar's state-expiration model:
//!
//! - **TTL_MIN** (100 ledgers): Minimum remaining TTL before an extension fires.
//! - **TTL_EXTEND_TO** (100 ledgers): Target TTL applied on every write.
//!
//! Every write to persistent storage is immediately followed by `extend_ttl`.
//! This applies to:
//!   - Individual `Booking(id)` entries (on create and every status change)
//!   - `BookingCount` counter (on every increment)
//!   - `PropertyBookings(property_id)` index (on every append)
//!
//! For production, TTL_EXTEND_TO should be tuned to the platform's activity
//! cadence (e.g., 17,280 ledgers ≈ 1 day at 5 s/ledger).

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, String, Vec};

// Import the property-listing contract's client and types for cross-contract calls.
use property_listing::{ListingStatus, PropertyListingContractClient};

// ─── TTL Constants ────────────────────────────────────────────────────────────

/// Minimum TTL threshold before an extension is triggered (in ledgers).
const TTL_MIN: u32 = 100;
/// Target TTL to extend entries to on every write (in ledgers).
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
}

/// A rental booking stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct Booking {
    pub id: u64,
    pub property_id: u64,
    pub tenant: Address,
    pub check_in: u64,  // Unix timestamp (seconds)
    pub check_out: u64, // Unix timestamp (seconds)
    pub total_price: i128,
    pub status: BookingStatus,
    pub escrow_id: String, // off-chain escrow reference (empty until set)
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Initialized flag
    Initialized,
    /// Admin address
    Admin,
    /// Address of the property-listing contract (set at initialization)
    PropertyListingContractId,
    /// Individual booking by ID
    Booking(u64),
    /// Total bookings ever created
    BookingCount,
    /// List of booking IDs for a given property
    PropertyBookings(u64),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct BookingContract;

#[contractimpl]
impl BookingContract {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Initialize the booking contract with an admin and a reference to the
    /// deployed property-listing contract.
    ///
    /// Must be called **exactly once** before any bookings can be created.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `admin` (`Address`) — Admin address that will be authorised for
    ///   status transitions and escrow operations; must authorise this call.
    /// - `property_listing_contract_id` (`Address`) — On-chain address of the
    ///   deployed `property-listing` contract used for cross-contract calls.
    ///
    /// # Panics
    ///
    /// - If `admin` has not authorised the transaction.
    /// - If the contract has already been initialized (`"Already initialized"`).
    ///
    /// # Side Effects
    ///
    /// - Writes `Initialized`, `Admin`, and `PropertyListingContractId` to
    ///   instance storage.
    pub fn initialize(env: Env, admin: Address, property_listing_contract_id: Address) {
        admin.require_auth();

        assert!(
            !env.storage()
                .instance()
                .has(&DataKey::Initialized),
            "Already initialized"
        );

        // Store admin and property-listing contract address in instance storage
        // (not persistent) because they are config values that should live as
        // long as the contract itself.
        env.storage()
            .instance()
            .set(&DataKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PropertyListingContractId, &property_listing_contract_id);
    }

    // ── Bookings ─────────────────────────────────────────────────────────────

    /// Create a new booking for a property, with date-overlap prevention and
    /// cross-contract availability verification.
    ///
    /// The function performs the following sequence:
    /// 1. Validates inputs (date ordering, positive price).
    /// 2. Cross-contract call to verify the property is `Active`.
    /// 3. Iterates existing bookings for the property to detect date overlaps.
    /// 4. Persists the booking, counter, and property-booking index.
    /// 5. Cross-contract call to mark the property as `Rented`.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `tenant` (`Address`) — Stellar address of the tenant making the booking;
    ///   must authorise this call.
    /// - `property_id` (`u64`) — ID of the property in the property-listing contract.
    /// - `check_in` (`u64`) — Unix timestamp (seconds) for the start of the stay.
    /// - `check_out` (`u64`) — Unix timestamp (seconds) for the end of the stay;
    ///   must be strictly after `check_in`.
    /// - `total_price` (`i128`) — Total booking cost in USDC stroops (must be > 0).
    ///
    /// # Returns
    ///
    /// `u64` — The newly assigned booking ID.
    ///
    /// # Panics
    ///
    /// - If `tenant` has not authorised the transaction.
    /// - If `check_in >= check_out`.
    /// - If `total_price <= 0`.
    /// - If the contract has not been initialized.
    /// - If the property does not exist or is not `Active`.
    /// - If the requested dates overlap with any non-cancelled booking.
    ///
    /// # Side Effects
    ///
    /// - Writes `Booking(id)` to persistent storage.
    /// - Increments and writes `BookingCount` to persistent storage.
    /// - Appends the new booking ID to `PropertyBookings(property_id)`.
    /// - Extends TTL on all three entries.
    /// - Calls `set_rented` on the property-listing contract (cross-contract).
    pub fn create_booking(
        env: Env,
        tenant: Address,
        property_id: u64,
        check_in: u64,
        check_out: u64,
        total_price: i128,
    ) -> u64 {
        tenant.require_auth();

        // ── Input validation ──────────────────────────────────────────────
        assert!(check_in < check_out, "check_in must be before check_out");
        assert!(total_price > 0, "total_price must be positive");

        // ── Cross-contract: verify property exists and is Active ──────────
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

        // ── Overlap prevention ────────────────────────────────────────────
        // Load the list of all booking IDs ever created for this property.
        // The list is append-only; cancelled bookings are skipped below.
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

            // Cancelled bookings release their date window, so they must
            // not block new reservations.
            if existing.status == BookingStatus::Cancelled {
                continue;
            }

            // Two date intervals [A_start, A_end) and [B_start, B_end) do NOT
            // overlap if and only if one ends before the other starts:
            //   A_end <= B_start  OR  A_start >= B_end
            // Negating that gives the overlap condition used here.
            let overlaps =
                !(check_out <= existing.check_in || check_in >= existing.check_out);
            assert!(!overlaps, "Booking dates overlap with an existing booking");
        }

        // ── Persist booking ───────────────────────────────────────────────
        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BookingCount)
            .unwrap_or(0);
        let id = count + 1;

        let booking = Booking {
            id,
            property_id,
            tenant,
            check_in,
            check_out,
            total_price,
            status: BookingStatus::Pending,
            escrow_id: String::from_str(&env, ""),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Booking(id), &booking);
        // Extend TTL immediately so the booking survives until checkout.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(id), TTL_MIN, TTL_EXTEND_TO);

        env.storage()
            .persistent()
            .set(&DataKey::BookingCount, &id);
        // Keep the counter alive — losing it would corrupt ID generation.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::BookingCount, TTL_MIN, TTL_EXTEND_TO);

        // Append the new booking ID to the per-property index so future
        // overlap checks and queries can find it.
        let mut bookings = property_bookings;
        bookings.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::PropertyBookings(property_id), &bookings);
        // The property index must outlive individual bookings because it
        // is the only way to enumerate them.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::PropertyBookings(property_id), TTL_MIN, TTL_EXTEND_TO);

        // ── Cross-contract: mark property as Rented ───────────────────────
        // This atomically flips the property to `Rented` in the listing
        // contract, preventing a race where another tenant could book the
        // same property before this transaction finalises.
        listing_client.set_rented(&property_id);

        id
    }

    /// Cancel a booking, setting its status to `Cancelled`.
    ///
    /// Only the original tenant may cancel. Cancelled bookings are excluded
    /// from future overlap checks, effectively freeing the date window.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must equal the booking's `tenant` and must
    ///   authorise this call.
    /// - `booking_id` (`u64`) — ID of the booking to cancel.
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If the booking does not exist (`"Booking not found"`).
    /// - If `caller` is not the tenant (`"Unauthorized"`).
    /// - If the booking is already `Cancelled`.
    /// - If the booking is `Completed` (terminal state).
    ///
    /// # Side Effects
    ///
    /// - Updates `Booking(booking_id).status` to `Cancelled` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn cancel_booking(env: Env, caller: Address, booking_id: u64) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

        assert!(booking.tenant == caller, "Unauthorized");
        assert!(
            booking.status != BookingStatus::Cancelled,
            "Booking already cancelled"
        );
        assert!(
            booking.status != BookingStatus::Completed,
            "Cannot cancel a completed booking"
        );

        booking.status = BookingStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Booking(booking_id), &booking);
        // Extend TTL so the cancellation record survives for audit/query purposes.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Update the status of a booking through the defined state machine.
    ///
    /// Enforces the following transition graph:
    ///
    /// ```text
    ///   Pending  ──→ Confirmed ──→ Completed
    ///     │              │
    ///     └──→ Cancelled ←──┘
    /// ```
    ///
    /// `Cancelled` and `Completed` are terminal states.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must be the contract admin and must authorise the tx.
    /// - `booking_id` (`u64`) — ID of the booking to transition.
    /// - `new_status` ([`BookingStatus`]) — Target status.
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If the contract has not been initialized.
    /// - If `caller` is not the admin (`"Unauthorized"`).
    /// - If the booking does not exist (`"Booking not found"`).
    /// - If the transition is not permitted (`"Invalid status transition"`).
    ///
    /// # Side Effects
    ///
    /// - Updates `Booking(booking_id).status` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn update_status(
        env: Env,
        caller: Address,
        booking_id: u64,
        new_status: BookingStatus,
    ) {
        caller.require_auth();

        // Only admin may call update_status
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

        // Validate transition — only edges present in the state machine
        // above are allowed; everything else (including self-transitions) is
        // rejected.
        let valid = match (&booking.status, &new_status) {
            (BookingStatus::Pending, BookingStatus::Confirmed) => true,
            (BookingStatus::Pending, BookingStatus::Cancelled) => true,
            (BookingStatus::Confirmed, BookingStatus::Completed) => true,
            (BookingStatus::Confirmed, BookingStatus::Cancelled) => true,
            _ => false,
        };
        assert!(valid, "Invalid status transition");

        booking.status = new_status;
        env.storage()
            .persistent()
            .set(&DataKey::Booking(booking_id), &booking);
        // Extend TTL after status change.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Attach an off-chain escrow reference to a booking.
    ///
    /// The `escrow_id` is an opaque string that links this on-chain booking
    /// to an off-chain escrow record (e.g., a Stellar Turrets escrow or a
    /// payment-processor transaction ID).
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must be the contract admin and must authorise the tx.
    /// - `booking_id` (`u64`) — ID of the booking to annotate.
    /// - `escrow_id` (`String`) — Off-chain escrow reference string.
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If the contract has not been initialized.
    /// - If `caller` is not the admin (`"Unauthorized"`).
    /// - If the booking does not exist (`"Booking not found"`).
    ///
    /// # Side Effects
    ///
    /// - Updates `Booking(booking_id).escrow_id` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn set_escrow_id(
        env: Env,
        caller: Address,
        booking_id: u64,
        escrow_id: String,
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

        booking.escrow_id = escrow_id;
        env.storage()
            .persistent()
            .set(&DataKey::Booking(booking_id), &booking);
        // Extend TTL after updating the escrow reference.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Booking(booking_id), TTL_MIN, TTL_EXTEND_TO);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Retrieve a booking by its on-chain ID.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `id` (`u64`) — Booking ID returned by [`create_booking`].
    ///
    /// # Returns
    ///
    /// [`Booking`] — The full booking struct.
    ///
    /// # Panics
    ///
    /// - If no booking with the given `id` exists (`"Booking not found"`).
    pub fn get_booking(env: Env, id: u64) -> Booking {
        env.storage()
            .persistent()
            .get(&DataKey::Booking(id))
            .expect("Booking not found")
    }

    /// Return all booking IDs for a given property.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `property_id` (`u64`) — Property ID in the property-listing contract.
    ///
    /// # Returns
    ///
    /// `Vec<u64>` — Booking IDs (may include cancelled bookings). Returns an
    /// empty vector if the property has no bookings.
    pub fn get_property_bookings(env: Env, property_id: u64) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::PropertyBookings(property_id))
            .unwrap_or(vec![&env])
    }

    /// Check whether a date range is available for a property (no active
    /// overlap with existing non-cancelled bookings).
    ///
    /// This is the read-only counterpart to the overlap check inside
    /// [`create_booking`]. Useful for UIs that want to validate dates before
    /// submitting a booking transaction.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `property_id` (`u64`) — Property ID to check.
    /// - `check_in` (`u64`) — Proposed check-in timestamp (seconds).
    /// - `check_out` (`u64`) — Proposed check-out timestamp (seconds).
    ///
    /// # Returns
    ///
    /// `bool` — `true` if the date range is free, `false` if it overlaps
    /// with at least one active booking.
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

            // Cancelled bookings don't block availability.
            if existing.status == BookingStatus::Cancelled {
                continue;
            }

            // Same overlap detection logic as create_booking (see explanation there).
            let overlaps =
                !(check_out <= existing.check_in || check_in >= existing.check_out);
            if overlaps {
                return false;
            }
        }
        true
    }

    /// Return the total number of bookings ever created.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    ///
    /// # Returns
    ///
    /// `u64` — Monotonic counter of all bookings created (never decremented).
    ///         Returns `0` if no bookings have been created yet.
    pub fn booking_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::BookingCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
