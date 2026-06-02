//! Review Contract for Rentars
//!
//! Allows tenants to submit on-chain reviews for users (owners/properties).
//! Enforces: rating 1–5, one review per reviewer per subject, unique IDs,
//! and per-subject review indexes.
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
//!   - Individual `Review(id)` entries (on submit)
//!   - `ReviewCount` counter (on every increment)
//!   - `UserReviews(reviewee)` index (on every append)
//!   - `HasReviewed(reviewer, reviewee)` duplicate-prevention flag (on set)
//!
//! For production, TTL_EXTEND_TO should be tuned to the platform's activity
//! cadence (e.g., 17,280 ledgers ≈ 1 day at 5 s/ledger).

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, String, Vec};

// ─── TTL Constants ────────────────────────────────────────────────────────────

/// Minimum TTL threshold before an extension is triggered (in ledgers).
const TTL_MIN: u32 = 100;
/// Target TTL to extend entries to on every write (in ledgers).
const TTL_EXTEND_TO: u32 = 100;

// ─── Data Types ──────────────────────────────────────────────────────────────

/// A single on-chain review.
#[contracttype]
#[derive(Clone)]
pub struct Review {
    pub id: u64,
    /// The address being reviewed (owner or property representative).
    pub reviewee: Address,
    /// The address submitting the review.
    pub reviewer: Address,
    /// Rating 1–5 (inclusive).
    pub rating: u32,
    /// Optional free-text comment.
    pub comment: String,
    /// Ledger timestamp at submission time.
    pub timestamp: u64,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Individual review by global ID.
    Review(u64),
    /// Total reviews ever submitted.
    ReviewCount,
    /// List of review IDs for a given reviewee.
    UserReviews(Address),
    /// Duplicate-prevention flag: (reviewer, reviewee) → bool.
    HasReviewed(Address, Address),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct ReviewContract;

#[contractimpl]
impl ReviewContract {
    /// Submit a review for a given `reviewee`.
    ///
    /// Enforces a **one-review-per-pair** invariant: a given `reviewer` may
    /// only review a given `reviewee` once. The review is timestamped with
    /// the current ledger timestamp.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `reviewer` (`Address`) — Stellar address submitting the review;
    ///   must authorise this call.
    /// - `reviewee` (`Address`) — Stellar address being reviewed (e.g., a
    ///   property owner).
    /// - `rating` (`u32`) — Rating from 1 to 5 inclusive.
    /// - `comment` (`String`) — Free-text review comment.
    ///
    /// # Returns
    ///
    /// `u64` — The newly assigned global review ID.
    ///
    /// # Panics
    ///
    /// - If `reviewer` has not authorised the transaction.
    /// - If `rating < 1` or `rating > 5`.
    /// - If the `reviewer` has already reviewed this `reviewee`
    ///   (`"Reviewer has already reviewed this user"`).
    ///
    /// # Side Effects
    ///
    /// - Writes `Review(id)` to persistent storage.
    /// - Increments and writes `ReviewCount` to persistent storage.
    /// - Sets the `HasReviewed(reviewer, reviewee)` flag to `true`.
    /// - Appends the review ID to `UserReviews(reviewee)`.
    /// - Extends TTL on all four entries.
    pub fn submit_review(
        env: Env,
        reviewer: Address,
        reviewee: Address,
        rating: u32,
        comment: String,
    ) -> u64 {
        reviewer.require_auth();

        // ── Validate rating ───────────────────────────────────────────────
        assert!(rating >= 1, "Rating must be at least 1");
        assert!(rating <= 5, "Rating must be at most 5");

        // ── Duplicate prevention ──────────────────────────────────────────
        // Use a (reviewer, reviewee) composite key to ensure that each
        // reviewer can submit at most one review per reviewee. This is a
        // boolean flag stored in persistent storage.
        let already_reviewed: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasReviewed(reviewer.clone(), reviewee.clone()))
            .unwrap_or(false);
        assert!(!already_reviewed, "Reviewer has already reviewed this user");

        // ── Persist ───────────────────────────────────────────────────────
        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0);
        let id = count + 1;

        let review = Review {
            id,
            reviewee: reviewee.clone(),
            reviewer: reviewer.clone(),
            rating,
            comment,
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Review(id), &review);
        // Extend TTL so the review persists for reputation queries.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Review(id), TTL_MIN, TTL_EXTEND_TO);

        env.storage()
            .persistent()
            .set(&DataKey::ReviewCount, &id);
        // Keep the counter alive — losing it would corrupt ID generation.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ReviewCount, TTL_MIN, TTL_EXTEND_TO);

        // Set the duplicate-prevention flag so a second review from the
        // same reviewer for this reviewee will be rejected.
        env.storage()
            .persistent()
            .set(&DataKey::HasReviewed(reviewer.clone(), reviewee.clone()), &true);
        // Extend TTL on the flag — if it expires, the reviewer could
        // accidentally submit a duplicate.
        env.storage()
            .persistent()
            .extend_ttl(
                &DataKey::HasReviewed(reviewer, reviewee.clone()),
                TTL_MIN,
                TTL_EXTEND_TO,
            );

        // Append to per-reviewee index so queries and reputation calculations
        // can enumerate all reviews for a given user.
        let mut user_reviews: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::UserReviews(reviewee.clone()))
            .unwrap_or(vec![&env]);
        user_reviews.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::UserReviews(reviewee.clone()), &user_reviews);
        // The per-reviewee index must survive as long as the reviews do.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::UserReviews(reviewee), TTL_MIN, TTL_EXTEND_TO);

        id
    }

    /// Retrieve a review by its global ID.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `id` (`u64`) — Review ID returned by [`submit_review`].
    ///
    /// # Returns
    ///
    /// [`Review`] — The full review struct.
    ///
    /// # Panics
    ///
    /// - If no review with the given `id` exists (`"Review not found"`).
    pub fn get_review(env: Env, id: u64) -> Review {
        env.storage()
            .persistent()
            .get(&DataKey::Review(id))
            .expect("Review not found")
    }

    /// Return all review IDs submitted for a given reviewee.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `reviewee` (`Address`) — The address whose reviews are requested.
    ///
    /// # Returns
    ///
    /// `Vec<u64>` — Review IDs. Returns an empty vector if no reviews exist.
    pub fn get_reviews_for_user(env: Env, reviewee: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::UserReviews(reviewee))
            .unwrap_or(vec![&env])
    }

    /// Return the average rating for a reviewee, scaled ×100 to avoid
    /// floating-point arithmetic (e.g., an average of 4.5 is returned as 450).
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    /// - `reviewee` (`Address`) — The address whose reputation score is requested.
    ///
    /// # Returns
    ///
    /// `u32` — `(sum_of_ratings * 100) / count`. Returns `0` if no reviews exist.
    pub fn get_reputation(env: Env, reviewee: Address) -> u32 {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::UserReviews(reviewee.clone()))
            .unwrap_or(vec![&env]);

        if ids.len() == 0 {
            return 0;
        }

        let mut total: u32 = 0;
        for i in 0..ids.len() {
            let rid = ids.get(i).unwrap();
            let review: Review = env
                .storage()
                .persistent()
                .get(&DataKey::Review(rid))
                .unwrap();
            total += review.rating;
        }

        // Multiply by 100 before dividing to preserve one decimal place of
        // precision without using floats. E.g., 4.5 → 450.
        (total * 100) / ids.len()
    }

    /// Return the total number of reviews ever submitted.
    ///
    /// # Parameters
    ///
    /// - `env` (`Env`) — Soroban host environment.
    ///
    /// # Returns
    ///
    /// `u64` — Monotonic counter of all reviews submitted (never decremented).
    ///         Returns `0` if no reviews have been submitted yet.
    pub fn review_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
