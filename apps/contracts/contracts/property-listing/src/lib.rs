//! Property Listing Contract for Rentars
//!
//! Manages on-chain property listings: create, read, update, and status management.
//! Each listing is owned by an Address and can only be mutated by its owner.
//!
//! ## Authorization Model (Issue 114)
//!
//! Every mutation entry point enforces an explicit authorized caller:
//!
//! | Entry point       | Authorized caller  | Notes                                         |
//! |-------------------|--------------------|-----------------------------------------------|
//! | `create_listing`  | `owner`            | Creates listing in `Active` state.             |
//! | `update_listing`  | `owner`            | Cannot update a `Removed` listing.            |
//! | `update_status`   | `owner`            | Cannot revive a `Removed` listing.            |
//! | `pause_listing`   | `owner`            | Transitions `Active` → `Inactive`.            |
//! | `unpause_listing` | `owner`            | Transitions `Inactive` → `Active`; blocked on `Removed`. |
//! | `remove_listing`  | `owner`            | Transitions any non-`Removed` state → `Removed`. |
//! | `set_rented`      | (cross-contract)   | Soroban contract-to-contract auth; `Active` only. |
//!
//! ## Status Transition Rules (Issue 114)
//!
//! Valid transitions via `update_status` (owner only):
//!
//! ```text
//!   Active ──→ Inactive     (owner pauses)
//!   Inactive ──→ Active     (owner unpauses)
//!   Active / Inactive ──→ Rented   (booking contract via set_rented)
//!   Rented ──→ Active       (owner re-activates after stay)
//!   Any non-Removed ──→ Removed    (via remove_listing; irreversible)
//! ```
//!
//! Removed listings cannot be updated, unpaused, or re-activated. This prevents
//! "zombie" re-activation and ensures deleted listings stay out of service.
//!
//! ## Input Validation (Issue 114)
//!
//! All mutating entry points validate inputs before writing state:
//!
//! | Entry point | Validated fields |
//! |-------------|-----------------|
//! | `create_listing` | `title` non-empty, `price_per_night` > 0 |
//! | `update_listing` | same as `create_listing`, plus caller == owner, listing not Removed |
//! | `update_status`  | caller == owner, listing not Removed |
//! | `pause_listing`  | caller == owner, listing must be Active |
//! | `unpause_listing`| caller == owner, listing must be Inactive (not Removed) |
//! | `remove_listing` | caller == owner, listing must not already be Removed |
//! | `set_rented`     | listing must be Active |
//!
//! ## Storage TTL Strategy (Issue 113 alignment)
//!
//! All persistent storage entries use TTL extensions to prevent ledger expiry.
//!
//! | Constant           | Ledgers    | Real-world duration          |
//! |--------------------|-----------|------------------------------|
//! | `LEDGER_THRESHOLD` |  120,960  | ~7 days  (at 5 s/ledger)    |
//! | `LEDGER_TARGET`    | 6,307,200 | ~1 year  (at 5 s/ledger)    |
//!
//! Rationale: `LEDGER_THRESHOLD` (~7 days) provides a comfortable buffer before
//! archival triggers. `LEDGER_TARGET` (~1 year) ensures listing records remain
//! accessible through typical ownership and rental lifecycles without requiring
//! frequent manual TTL refreshes.
//!
//! Every write to persistent storage is immediately followed by an `extend_ttl`
//! call. Reads that return a listing also extend TTL to keep frequently accessed
//! records alive. This applies to:
//!   - Individual `Listing(id)` entries (on create, update, status change, and read)
//!   - The `ListingCount` counter (on every increment and read)
//!
//! For production deployments, a background keeper job should monitor TTL and
//! extend entries proactively to avoid archival of long-idle listings.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracterror, contracttype, Address, Env, String};

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
/// Approximately 1 year — matches expected platform activity and far exceeds
/// any realistic single rental period or listing lifecycle.
const LEDGER_TARGET: u32 = 6_307_200;

// ─── Data Types ──────────────────────────────────────────────────────────────

/// Status of a property listing.
///
/// ## Valid transitions
///
/// ```text
///   Active ──→ Inactive          (owner calls pause_listing or update_status)
///   Inactive ──→ Active          (owner calls unpause_listing or update_status)
///   Active ──→ Rented            (booking contract calls set_rented)
///   Rented ──→ Active            (owner re-activates via update_status)
///   Active / Inactive / Rented ──→ Removed  (owner calls remove_listing; irreversible)
/// ```
///
/// `Removed` is a terminal state. No entry point permits transitioning out of it
/// (Issue 114: prevent zombie re-activation).
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ListingStatus {
    Active,
    Inactive,
    Rented,
    /// Terminal state: listing has been permanently removed by the owner.
    /// No further mutations are permitted on a Removed listing.
    Removed,
}

/// A property listing stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct PropertyListing {
    pub id: u64,
    pub owner: Address,
    pub title: String,
    pub description: String,
    pub price_per_night: i128, // in USDC stroops (1 USDC = 10_000_000 stroops)
    pub status: ListingStatus,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    Listing(u64),
    ListingCount,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Contract error codes for the property-listing contract.
///
/// ## Validation Rules enforced on every write
///
/// | Input | Constraint | Error variant |
/// |-------|-----------|---------------|
/// | `title` | Non-empty string (length ≥ 1) | `InvalidInput` |
/// | `price_per_night` | Strictly positive (> 0) in USDC stroops | `InvalidInput` |
/// | Caller (`update_listing` / `update_status` / `pause_listing` / `unpause_listing` / `remove_listing`) | Must be the original listing owner | `Unauthorized` |
/// | Listing ID (`get_listing` / `update_listing` / `update_status` / `set_rented` / ...) | Must exist in storage | `NotFound` |
/// | `set_rented` | Listing must be in `Active` status | `InvalidInput` |
/// | `update_listing` / `update_status` / `unpause_listing` | Listing must not be `Removed` | `InvalidInput` |
/// | `remove_listing` | Listing must not already be `Removed` | `InvalidInput` |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// The requested listing ID does not exist in storage.
    NotFound = 1,
    /// The caller is not the listing owner.
    Unauthorized = 2,
    /// Reserved — a listing with this identifier already exists.
    AlreadyExists = 3,
    /// An input field fails validation: empty title, non-positive price,
    /// or an invalid/disallowed status transition.
    InvalidInput = 4,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct PropertyListingContract;

#[contractimpl]
impl PropertyListingContract {
    /// Create a new property listing and persist it to on-chain storage.
    ///
    /// Assigns a monotonically increasing ID, sets status to `Active`, and
    /// writes the listing and the updated counter to persistent storage.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment (provides storage, auth, etc.).
    /// - `owner` (`Address`) — Stellar address of the property owner; must authorise this call.
    /// - `title` (`String`) — Human-readable title for the listing (must not be empty).
    /// - `description` (`String`) — Free-text property description.
    /// - `price_per_night` (`i128`) — Nightly rate in USDC stroops (must be > 0).
    ///
    /// # Returns
    ///
    /// `u64` — The newly assigned listing ID (starts at 1, increments globally).
    ///
    /// # Panics
    ///
    /// - If `owner` has not authorised the transaction.
    /// - If `price_per_night <= 0`.
    /// - If `title` is empty (zero length).
    ///
    /// # Side Effects
    ///
    /// - Writes `Listing(id)` to persistent storage with TTL extended to ~1 year.
    /// - Writes updated `ListingCount` to persistent storage with TTL extended to ~1 year.
    pub fn create_listing(
        env: Env,
        owner: Address,
        title: String,
        description: String,
        price_per_night: i128,
    ) -> u64 {
        owner.require_auth();

        // Validate inputs — fail fast before any storage reads/writes.
        assert!(price_per_night > 0, "price_per_night must be positive");
        assert!(title.len() > 0, "title must not be empty");

        // Read the current global counter; defaults to 0 for a freshly deployed contract.
        let count_key = DataKey::ListingCount;
        let count: u64 = env
            .storage()
            .persistent()
            .get(&count_key)
            .unwrap_or(0);
        let id = count + 1;

        let listing = PropertyListing {
            id,
            owner,
            title,
            description,
            price_per_night,
            status: ListingStatus::Active,
        };

        let listing_key = DataKey::Listing(id);
        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        // Immediately extend TTL so the new entry doesn't start with a short
        // remaining lifetime inherited from the ledger default.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        env.storage()
            .persistent()
            .set(&count_key, &id);
        // Keep the counter alive — losing it would freeze ID generation.
        env.storage()
            .persistent()
            .extend_ttl(&count_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        id
    }

    /// Retrieve a listing by its on-chain ID.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `id` (`u64`) — Listing ID returned by [`create_listing`].
    ///
    /// # Returns
    ///
    /// [`PropertyListing`] — The full listing struct.
    ///
    /// # Panics
    ///
    /// - If no listing with the given `id` exists (`"Listing not found"`).
    pub fn get_listing(env: Env, id: u64) -> PropertyListing {
        let listing_key = DataKey::Listing(id);
        let listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read to keep frequently accessed records alive.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        listing
    }

    /// Update a listing's mutable fields (title, description, price).
    ///
    /// The listing's `id`, `owner`, and `status` remain unchanged.
    ///
    /// # Authorization and state guards (Issue 114)
    ///
    /// - Caller must be the listing owner and must authorise the transaction.
    /// - The listing must NOT be in `Removed` state; updates to removed listings
    ///   are rejected to prevent ghost-record mutations.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must equal the listing's `owner` and must authorise the tx.
    /// - `id` (`u64`) — ID of the listing to update.
    /// - `title` (`String`) — New title (must not be empty).
    /// - `description` (`String`) — New description.
    /// - `price_per_night` (`i128`) — New nightly rate in USDC stroops (must be > 0).
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing is in `Removed` state (`"Cannot update a removed listing"`).
    /// - If `price_per_night <= 0` or `title` is empty.
    ///
    /// # Side Effects
    ///
    /// - Overwrites `Listing(id)` in persistent storage with updated fields.
    /// - Extends TTL on the updated entry.
    pub fn update_listing(
        env: Env,
        caller: Address,
        id: u64,
        title: String,
        description: String,
        price_per_night: i128,
    ) {
        caller.require_auth();

        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(listing.owner == caller, "Unauthorized");

        // Issue 114: prevent mutations on removed listings (guard against
        // ghost-record updates that would silently re-populate a deleted entry).
        assert!(
            listing.status != ListingStatus::Removed,
            "Cannot update a removed listing"
        );

        assert!(price_per_night > 0, "price_per_night must be positive");
        assert!(title.len() > 0, "title must not be empty");

        listing.title = title;
        listing.description = description;
        listing.price_per_night = price_per_night;

        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        // Refresh TTL after update so the entry survives until the next interaction.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Update the status of a listing (owner only).
    ///
    /// This is the general status setter used for transitions such as
    /// `Rented` → `Active` (re-activating after a completed stay). For the
    /// purpose of pausing and removing listings, prefer the dedicated
    /// `pause_listing`, `unpause_listing`, and `remove_listing` entry points
    /// which carry intent-specific guards.
    ///
    /// # Authorization and state guards (Issue 114)
    ///
    /// - Caller must be the listing owner and must authorise the transaction.
    /// - The listing must NOT be in `Removed` state; status changes on removed
    ///   listings are rejected (prevents "zombie re-activation").
    /// - The `Removed` status cannot be set via this entry point; use
    ///   `remove_listing` instead.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must equal the listing's `owner` and must authorise the tx.
    /// - `id` (`u64`) — ID of the listing whose status is being changed.
    /// - `status` ([`ListingStatus`]) — The new status value. Must not be `Removed`.
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing is in `Removed` state (`"Cannot change status of a removed listing"`).
    /// - If `status` is `Removed` (`"Use remove_listing to remove a listing"`).
    ///
    /// # Side Effects
    ///
    /// - Overwrites the `status` field on `Listing(id)` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn update_status(env: Env, caller: Address, id: u64, status: ListingStatus) {
        caller.require_auth();

        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(listing.owner == caller, "Unauthorized");

        // Issue 114: removed listings are terminal — no further transitions.
        assert!(
            listing.status != ListingStatus::Removed,
            "Cannot change status of a removed listing"
        );
        // Issue 114: Removed must only be set via remove_listing to enforce
        // the irreversibility invariant.
        assert!(
            status != ListingStatus::Removed,
            "Use remove_listing to remove a listing"
        );

        listing.status = status;

        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        // Refresh TTL after status change.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Pause a listing: transition `Active` → `Inactive` (owner only).
    ///
    /// A paused listing does not accept new bookings. This is the preferred
    /// entry point for temporary owner-initiated unavailability (e.g., maintenance
    /// window, seasonal closure).
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing is not `Active` (`"Listing must be Active to pause"`).
    pub fn pause_listing(env: Env, caller: Address, id: u64) {
        caller.require_auth();

        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(listing.owner == caller, "Unauthorized");
        assert!(
            listing.status == ListingStatus::Active,
            "Listing must be Active to pause"
        );

        listing.status = ListingStatus::Inactive;
        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Unpause a listing: transition `Inactive` → `Active` (owner only).
    ///
    /// Re-opens the listing to new bookings. Explicitly blocked on `Removed`
    /// listings to prevent zombie re-activation (Issue 114).
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing is `Removed` (`"Cannot unpause a removed listing"`).
    /// - If the listing is not `Inactive` (`"Listing must be Inactive to unpause"`).
    pub fn unpause_listing(env: Env, caller: Address, id: u64) {
        caller.require_auth();

        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(listing.owner == caller, "Unauthorized");

        // Issue 114: removed listings cannot be re-activated (zombie prevention).
        assert!(
            listing.status != ListingStatus::Removed,
            "Cannot unpause a removed listing"
        );
        assert!(
            listing.status == ListingStatus::Inactive,
            "Listing must be Inactive to unpause"
        );

        listing.status = ListingStatus::Active;
        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Permanently remove a listing (owner only).
    ///
    /// Transitions the listing to `Removed` status. This is an irreversible
    /// operation — `Removed` is a terminal state. No entry point in this
    /// contract permits transitioning out of `Removed` (Issue 114: prevent
    /// zombie re-activation and bypass of active-reservation guards).
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing is already `Removed` (`"Listing is already removed"`).
    pub fn remove_listing(env: Env, caller: Address, id: u64) {
        caller.require_auth();

        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(listing.owner == caller, "Unauthorized");
        assert!(
            listing.status != ListingStatus::Removed,
            "Listing is already removed"
        );

        listing.status = ListingStatus::Removed;
        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Set a listing's status to `Rented` on behalf of the booking contract.
    ///
    /// This entry point is intended for **cross-contract calls** from the
    /// booking contract. It does NOT require the property owner's auth —
    /// instead, Soroban's automatic contract-to-contract authorisation
    /// applies when the booking contract invokes this function.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `id` (`u64`) — Listing ID to mark as rented.
    ///
    /// # Panics
    ///
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing's current status is not `Active`
    ///   (`"Property is not available for booking"`).
    ///
    /// # Side Effects
    ///
    /// - Changes `Listing(id).status` to `Rented` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn set_rented(env: Env, id: u64) {
        let listing_key = DataKey::Listing(id);
        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .expect("Listing not found");

        // Extend TTL on read.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);

        assert!(
            listing.status == ListingStatus::Active,
            "Property is not available for booking"
        );

        listing.status = ListingStatus::Rented;

        env.storage()
            .persistent()
            .set(&listing_key, &listing);
        // Refresh TTL — the booking contract relies on this entry surviving.
        env.storage()
            .persistent()
            .extend_ttl(&listing_key, LEDGER_THRESHOLD, LEDGER_TARGET);
    }

    /// Return the total number of listings ever created.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    ///
    /// # Returns
    ///
    /// `u64` — Monotonic counter of all listings created (never decremented).
    ///         Returns `0` if no listings have been created yet.
    pub fn listing_count(env: Env) -> u64 {
        let key = DataKey::ListingCount;
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
