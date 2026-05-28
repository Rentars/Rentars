// Rentars — Review Soroban Smart Contract
// Built on Stellar blockchain
// Handles: on-chain reviews and reputation scoring for tenants and owners

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, Env, String, Vec};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum allowed rating value (inclusive).
const RATING_MIN: u32 = 1;
/// Maximum allowed rating value (inclusive).
const RATING_MAX: u32 = 5;
/// Maximum allowed comment length in bytes.
const COMMENT_MAX_LEN: u32 = 500;

// ---------------------------------------------------------------------------
// Error enum
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum ReviewError {
    /// Rating is outside the 1–5 range.
    InvalidRating = 1,
    /// A review for this booking by this reviewer already exists.
    DuplicateReview = 2,
    /// The caller is not authorised to submit this review.
    UnauthorizedReviewer = 3,
    /// One or more input fields are invalid (e.g. empty DID, comment too long).
    InvalidInput = 4,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct Review {
    /// Unique review identifier (auto-incremented).
    pub id: u64,
    /// The booking this review is associated with.
    pub booking_id: u64,
    /// DID of the user submitting the review.
    pub reviewer_did: String,
    /// DID of the user being reviewed.
    pub target_did: String,
    /// Rating from 1 (worst) to 5 (best).
    pub rating: u32,
    /// Optional free-text comment (max 500 chars).
    pub comment: String,
    /// Unix timestamp (seconds) when the review was submitted.
    pub timestamp: u64,
}

#[contracttype]
pub enum DataKey {
    /// Individual review by ID.
    Review(u64),
    /// Total number of reviews ever submitted (used for ID generation).
    ReviewCount,
    /// List of review IDs submitted about a given target DID.
    TargetReviews(String),
    /// Deduplication key: (booking_id, reviewer_did) → bool.
    ReviewExists(u64, String),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReviewContract;

#[contractimpl]
impl ReviewContract {
    // -----------------------------------------------------------------------
    // Write functions
    // -----------------------------------------------------------------------

    /// Submit a review for a completed booking.
    ///
    /// # Arguments
    /// * `booking_id`    – ID of the booking being reviewed.
    /// * `reviewer_did`  – Decentralised identifier of the reviewer.
    /// * `target_did`    – Decentralised identifier of the user being reviewed.
    /// * `rating`        – Integer rating between 1 and 5 (inclusive).
    /// * `comment`       – Free-text comment, maximum 500 characters.
    ///
    /// # Errors
    /// * `ReviewError::InvalidRating`        – rating is not in [1, 5].
    /// * `ReviewError::InvalidInput`         – DIDs are empty or comment exceeds 500 chars.
    /// * `ReviewError::DuplicateReview`      – reviewer already reviewed this booking.
    pub fn submit_review(
        env: Env,
        booking_id: u64,
        reviewer_did: String,
        target_did: String,
        rating: u32,
        comment: String,
    ) -> u64 {
        // --- Input validation ---

        // Rating must be in [1, 5]
        if rating < RATING_MIN || rating > RATING_MAX {
            panic_with_error!(&env, ReviewError::InvalidRating);
        }

        // DIDs must not be empty
        if reviewer_did.len() == 0 || target_did.len() == 0 {
            panic_with_error!(&env, ReviewError::InvalidInput);
        }

        // Comment must not exceed 500 characters
        if comment.len() > COMMENT_MAX_LEN {
            panic_with_error!(&env, ReviewError::InvalidInput);
        }

        // Reviewer and target must be different
        if reviewer_did == target_did {
            panic_with_error!(&env, ReviewError::UnauthorizedReviewer);
        }

        // --- Duplicate prevention ---
        let dedup_key = DataKey::ReviewExists(booking_id, reviewer_did.clone());
        let already_reviewed: bool = env
            .storage()
            .persistent()
            .get(&dedup_key)
            .unwrap_or(false);

        if already_reviewed {
            panic_with_error!(&env, ReviewError::DuplicateReview);
        }

        // --- Persist the review ---
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0);
        let id = count + 1;

        let review = Review {
            id,
            booking_id,
            reviewer_did: reviewer_did.clone(),
            target_did: target_did.clone(),
            rating,
            comment,
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Review(id), &review);
        env.storage()
            .instance()
            .set(&DataKey::ReviewCount, &id);

        // Mark this (booking, reviewer) pair as reviewed to prevent duplicates
        env.storage().persistent().set(&dedup_key, &true);

        // Append review ID to the target's review list
        let target_key = DataKey::TargetReviews(target_did.clone());
        let mut target_reviews: Vec<u64> = env
            .storage()
            .persistent()
            .get(&target_key)
            .unwrap_or_else(|| Vec::new(&env));
        target_reviews.push_back(id);
        env.storage()
            .persistent()
            .set(&target_key, &target_reviews);

        id
    }

    // -----------------------------------------------------------------------
    // Read functions
    // -----------------------------------------------------------------------

    /// Return all reviews submitted about a given target DID.
    pub fn get_reviews_for_user(env: Env, target_did: String) -> Vec<Review> {
        let target_key = DataKey::TargetReviews(target_did);
        let review_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&target_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut reviews: Vec<Review> = Vec::new(&env);
        for id in review_ids.iter() {
            if let Some(review) = env
                .storage()
                .persistent()
                .get::<DataKey, Review>(&DataKey::Review(id))
            {
                reviews.push_back(review);
            }
        }
        reviews
    }

    /// Return the average rating for a given target DID as an integer (1–5).
    ///
    /// Returns 0 if the user has no reviews yet.
    pub fn get_reputation(env: Env, target_did: String) -> u32 {
        let target_key = DataKey::TargetReviews(target_did);
        let review_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&target_key)
            .unwrap_or_else(|| Vec::new(&env));

        let count = review_ids.len();
        if count == 0 {
            return 0;
        }

        let mut total: u64 = 0;
        for id in review_ids.iter() {
            if let Some(review) = env
                .storage()
                .persistent()
                .get::<DataKey, Review>(&DataKey::Review(id))
            {
                total += review.rating as u64;
            }
        }

        // Integer average, rounded down
        (total / count as u64) as u32
    }

    /// Get a single review by its ID.
    pub fn get_review(env: Env, id: u64) -> Review {
        env.storage()
            .persistent()
            .get(&DataKey::Review(id))
            .expect("Review not found")
    }

    /// Return the total number of reviews ever submitted.
    pub fn get_review_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0)
    }
}
