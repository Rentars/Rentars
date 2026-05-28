# Review Contract — CONTRACT_OVERVIEW

> **Crate:** `rentars-review-contract`  
> **Location:** `apps/contracts/contracts/review-contract/`  
> **Runtime:** Soroban (Stellar smart contract platform)  
> **SDK version:** `soroban-sdk = "21.0.0"`

---

## Purpose

The Review Contract provides on-chain reviews and reputation scoring for the Rentars platform. After a rental is completed, either party (tenant or owner) can submit a review for the other. All reviews are stored on-chain, making the reputation system fully transparent and tamper-proof.

---

## Data Structures

### `Review`

```rust
pub struct Review {
    pub id: u64,              // Auto-incremented unique identifier
    pub booking_id: u64,      // The booking this review is tied to
    pub reviewer_did: String, // DID of the user submitting the review
    pub target_did: String,   // DID of the user being reviewed
    pub rating: u32,          // Integer rating: 1 (worst) to 5 (best)
    pub comment: String,      // Free-text comment, max 500 characters
    pub timestamp: u64,       // Unix timestamp (seconds) of submission
}
```

### `ReviewError`

| Variant               | Code | Description                                                  |
|-----------------------|------|--------------------------------------------------------------|
| `InvalidRating`       | 1    | Rating is outside the 1–5 range                              |
| `DuplicateReview`     | 2    | Reviewer already submitted a review for this booking         |
| `UnauthorizedReviewer`| 3    | Reviewer and target DIDs are the same (self-review attempt)  |
| `InvalidInput`        | 4    | Empty DID(s) or comment exceeds 500 characters               |

---

## Storage Layout

| Key                                  | Type          | Description                                          |
|--------------------------------------|---------------|------------------------------------------------------|
| `DataKey::Review(id)`                | `Review`      | Individual review stored by its ID (persistent)      |
| `DataKey::ReviewCount`               | `u64`         | Total reviews ever submitted — used for ID gen       |
| `DataKey::TargetReviews(target_did)` | `Vec<u64>`    | Ordered list of review IDs for a given target DID    |
| `DataKey::ReviewExists(booking_id, reviewer_did)` | `bool` | Deduplication flag per (booking, reviewer) pair |

---

## Contract Interface

### `submit_review`

```rust
fn submit_review(
    env: Env,
    booking_id: u64,
    reviewer_did: String,
    target_did: String,
    rating: u32,
    comment: String,
) -> u64
```

Submits a new review and returns the assigned review ID.

**Validation rules:**
- `rating` must be between **1 and 5** (inclusive) — panics with `ReviewError::InvalidRating` otherwise.
- `reviewer_did` and `target_did` must be non-empty — panics with `ReviewError::InvalidInput` otherwise.
- `comment` must be **≤ 500 characters** — panics with `ReviewError::InvalidInput` otherwise.
- `reviewer_did` must differ from `target_did` (no self-reviews) — panics with `ReviewError::UnauthorizedReviewer`.
- Each `(booking_id, reviewer_did)` pair may only be reviewed **once** — panics with `ReviewError::DuplicateReview` on a second attempt.

**Side effects:**
- Stores the `Review` struct under `DataKey::Review(id)`.
- Increments `DataKey::ReviewCount`.
- Appends the new review ID to `DataKey::TargetReviews(target_did)`.
- Sets `DataKey::ReviewExists(booking_id, reviewer_did)` to `true`.

---

### `get_reviews_for_user`

```rust
fn get_reviews_for_user(env: Env, target_did: String) -> Vec<Review>
```

Returns all `Review` structs submitted about the given `target_did`, in submission order. Returns an empty vector if the user has no reviews.

---

### `get_reputation`

```rust
fn get_reputation(env: Env, target_did: String) -> u32
```

Returns the **average rating** (integer, rounded down) across all reviews for `target_did`.

- Returns `0` if the user has no reviews yet.
- Range of non-zero return values: **1–5**.

---

### `get_review`

```rust
fn get_review(env: Env, id: u64) -> Review
```

Returns a single `Review` by its ID. Panics with `"Review not found"` if the ID does not exist.

---

### `get_review_count`

```rust
fn get_review_count(env: Env) -> u64
```

Returns the total number of reviews ever submitted to this contract.

---

## Usage Flow

```
1. Rental completes (booking reaches Completed status in rental-contract)
2. Tenant calls submit_review(booking_id, tenant_did, owner_did, rating, comment)
3. Owner calls submit_review(booking_id, owner_did, tenant_did, rating, comment)
4. Anyone can call get_reputation(did) to read a user's average score
5. Anyone can call get_reviews_for_user(did) to read the full review history
```

---

## Building

```bash
# From the workspace root (apps/contracts/)
cargo build --target wasm32-unknown-unknown --release

# Build only the review contract
cargo build -p rentars-review-contract --target wasm32-unknown-unknown --release
```

The compiled WASM artifact will be at:
```
apps/contracts/target/wasm32-unknown-unknown/release/rentars_review_contract.wasm
```

---

## Design Decisions

- **Persistent storage** is used for reviews and review lists so they survive ledger TTL expiry (unlike instance storage which is tied to the contract instance TTL).
- **Instance storage** is used for the review counter since it is accessed on every write and benefits from the lower cost of instance reads.
- **DIDs** (Decentralised Identifiers) are used instead of `Address` for reviewer/target identity to support off-chain identity systems and cross-chain portability.
- **Integer average** is returned by `get_reputation` to keep the interface simple and avoid floating-point issues in WASM. Callers can multiply by 10 or 100 before dividing if they need one or two decimal places.
- **Duplicate prevention** is keyed on `(booking_id, reviewer_did)` rather than just `reviewer_did` so that a user who participates in multiple bookings can leave a review for each one.
