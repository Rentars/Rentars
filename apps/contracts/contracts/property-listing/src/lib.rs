//! Property Listing Contract for Rentars
//!
//! Manages on-chain property listings: create, read, update, and status management.
//! Each listing is owned by an Address and can only be mutated by its owner.
//!
//! ## Storage TTL Strategy
//!
//! All persistent storage entries use TTL (time-to-live) extensions to prevent
//! ledger entry expiry on Stellar's state-expiration model:
//!
//! - **MIN_TTL** (100 ledgers): The minimum TTL threshold — if the remaining TTL
//!   falls below this value, the entry is extended.
//! - **EXTEND_TO** (100 ledgers): The target TTL to extend to when an entry is
//!   refreshed. This keeps entries alive through normal usage patterns.
//!
//! Every write to persistent storage is immediately followed by an `extend_ttl`
//! call so that newly written or updated entries start with a full TTL budget.
//! This applies to:
//!   - Individual `Listing(id)` entries (on create, update, and status change)
//!   - The `ListingCount` counter (on every increment)
//!
//! For production deployments, EXTEND_TO should be tuned to match the expected
//! activity cadence of the platform (e.g., 17,280 ledgers ≈ 1 day at 5s/ledger).
//!
//! ## Input Validation
//!
//! All mutating entry points validate inputs before writing state.
//! Invalid inputs cause the contract to panic with a descriptive message;
//! the corresponding [`ContractError`] variant is documented on the enum.
//!
//! | Entry point | Validated fields |
//! |-------------|-----------------|
//! | `create_listing` | `title` non-empty, `price_per_night` > 0 |
//! | `update_listing` | same as `create_listing`, plus caller == owner |
//! | `update_status` | caller == owner |
//! | `set_rented` | listing must be `Active` |

#![no_std]

use soroban_sdk::{contract, contractimpl, contracterror, contracttype, Address, Env, String};

// ─── TTL Constants ────────────────────────────────────────────────────────────

/// Minimum TTL threshold before an extension is triggered (in ledgers).
const TTL_MIN: u32 = 100;
/// Target TTL to extend entries to on every write (in ledgers).
const TTL_EXTEND_TO: u32 = 100;

// ─── Invariant / Bound Constants ──────────────────────────────────────────────

/// Semantic contract version for upgrade detection (major * 100 + minor).
pub const CONTRACT_VERSION: u32 = 100; // 1.0
/// Maximum nightly price in USDC stroops (~100k USDC/night).
const MAX_PRICE_PER_NIGHT: i128 = 100_000_0000000;
/// Maximum title length in bytes.
const MAX_TITLE_LEN: u32 = 200;

// ─── Data Types ──────────────────────────────────────────────────────────────

/// Status of a property listing.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ListingStatus {
    Active,
    Inactive,
    Rented,
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
    /// Optional address of the booking contract authorised to call `set_rented`.
    BookingContract,
    Initialized,
    Admin,
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
/// | Caller (`update_listing` / `update_status`) | Must be the original listing owner | `Unauthorized` |
/// | Listing ID (`get_listing` / `update_listing` / `update_status` / `set_rented`) | Must exist in storage | `NotFound` |
/// | `set_rented` | Listing must be in `Active` status | `InvalidInput` |
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
    /// An input field fails validation: empty title or non-positive price.
    InvalidInput = 4,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct PropertyListingContract;

#[contractimpl]
impl PropertyListingContract {
    /// One-time initialization: store admin and optional booking-contract authority.
    ///
    /// When `booking_contract` is set, only that address may call [`set_rented`].
    /// Call before production use so unauthorized EOAs cannot flip listings to Rented.
    pub fn initialize(env: Env, admin: Address, booking_contract: Address) {
        admin.require_auth();
        assert!(
            !env.storage().instance().has(&DataKey::Initialized),
            "Already initialized"
        );
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BookingContract, &booking_contract);
    }

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
    /// - Writes `Listing(id)` to persistent storage.
    /// - Writes updated `ListingCount` to persistent storage.
    /// - Extends TTL on both entries to prevent ledger expiry.
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
        assert!(
            price_per_night <= MAX_PRICE_PER_NIGHT,
            "price_per_night exceeds maximum bound"
        );
        assert!(title.len() > 0, "title must not be empty");
        assert!(title.len() <= MAX_TITLE_LEN, "title exceeds maximum length");

        // Read the current global counter; defaults to 0 for a freshly deployed contract.
        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::ListingCount)
            .unwrap_or(0);
        let id = count
            .checked_add(1)
            .expect("listing id counter overflow");

        let listing = PropertyListing {
            id,
            owner,
            title,
            description,
            price_per_night,
            status: ListingStatus::Active,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Listing(id), &listing);
        // Immediately extend TTL after writing so the new entry doesn't start
        // with a short remaining lifetime inherited from the ledger default.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Listing(id), TTL_MIN, TTL_EXTEND_TO);

        env.storage()
            .persistent()
            .set(&DataKey::ListingCount, &id);
        // Keep the counter alive — losing it would freeze ID generation.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ListingCount, TTL_MIN, TTL_EXTEND_TO);

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
        env.storage()
            .persistent()
            .get(&DataKey::Listing(id))
            .expect("Listing not found")
    }

    /// Update a listing's mutable fields (title, description, price).
    ///
    /// The listing's `id`, `owner`, and `status` remain unchanged.
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

        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(id))
            .expect("Listing not found");

        assert!(listing.owner == caller, "Unauthorized");
        assert!(price_per_night > 0, "price_per_night must be positive");
        assert!(
            price_per_night <= MAX_PRICE_PER_NIGHT,
            "price_per_night exceeds maximum bound"
        );
        assert!(title.len() > 0, "title must not be empty");
        assert!(title.len() <= MAX_TITLE_LEN, "title exceeds maximum length");

        listing.title = title;
        listing.description = description;
        listing.price_per_night = price_per_night;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(id), &listing);
        // Refresh TTL after update so the entry survives until the next interaction.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Listing(id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Update the status of a listing (e.g., Active → Inactive).
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `caller` (`Address`) — Must equal the listing's `owner` and must authorise the tx.
    /// - `id` (`u64`) — ID of the listing whose status is being changed.
    /// - `status` ([`ListingStatus`]) — The new status value.
    ///
    /// # Panics
    ///
    /// - If `caller` has not authorised the transaction.
    /// - If `caller` is not the listing owner (`"Unauthorized"`).
    /// - If the listing does not exist (`"Listing not found"`).
    ///
    /// # Side Effects
    ///
    /// - Overwrites the `status` field on `Listing(id)` in persistent storage.
    /// - Extends TTL on the updated entry.
    pub fn update_status(env: Env, caller: Address, id: u64, status: ListingStatus) {
        caller.require_auth();

        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(id))
            .expect("Listing not found");

        assert!(listing.owner == caller, "Unauthorized");

        listing.status = status;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(id), &listing);
        // Refresh TTL after status change.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Listing(id), TTL_MIN, TTL_EXTEND_TO);
    }

    /// Set a listing's status to `Rented` on behalf of the booking contract.
    ///
    /// When the property-listing contract has been [`initialize`]d with a
    /// booking-contract address, that address must authorise the call
    /// (`booking_contract.require_auth()`). Uninitialized deployments keep
    /// legacy behaviour for fixtures, but production MUST call `initialize`.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `id` (`u64`) — Listing ID to mark as rented.
    ///
    /// # Panics
    ///
    /// - If a booking contract is configured and has not authorised the call.
    /// - If the listing does not exist (`"Listing not found"`).
    /// - If the listing's current status is not `Active`
    ///   (`"Property is not available for booking"`).
    pub fn set_rented(env: Env, id: u64) {
        // Enforce booking-contract auth when configured (mainnet hardening).
        if let Some(authorized) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::BookingContract)
        {
            authorized.require_auth();
        }

        let mut listing: PropertyListing = env
            .storage()
            .persistent()
            .get(&DataKey::Listing(id))
            .expect("Listing not found");

        assert!(
            listing.status == ListingStatus::Active,
            "Property is not available for booking"
        );

        listing.status = ListingStatus::Rented;

        env.storage()
            .persistent()
            .set(&DataKey::Listing(id), &listing);
        // Refresh TTL — the booking contract relies on this entry surviving.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Listing(id), TTL_MIN, TTL_EXTEND_TO);
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
        env.storage()
            .persistent()
            .get(&DataKey::ListingCount)
            .unwrap_or(0)
    }

    /// Return the semantic contract version used for upgrade detection.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod invariants;
