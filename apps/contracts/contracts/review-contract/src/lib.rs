// Rentars — Review Soroban Smart Contract
// Built on Stellar blockchain
// Handles: on-chain reviews and reputation scoring

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Vec};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATING_MIN: u32 = 1;
const RATING_MAX: u32 = 5;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct Review {
    pub id: u64,
    pub reviewer: Address,
    pub reviewee: Address,
    pub rating: u32,
    pub comment: String,
    pub timestamp: u64,
}

#[contracttype]
pub enum DataKey {
    /// Individual review by ID.
    Review(u64),
    /// Total reviews submitted (used for ID generation), stored in instance.
    ReviewCount,
    /// List of review IDs targeting a given reviewee address.
    TargetReviews(Address),
    /// Deduplication flag: (reviewer, reviewee) → bool, stored in instance.
    HasReviewed(Address, Address),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReviewContract;

#[contractimpl]
impl ReviewContract {
    /// Submit a review from `reviewer` about `reviewee`.
    ///
    /// Each (reviewer, reviewee) pair can only submit one review.
    /// Rating must be in [1, 5]. Comment may be empty.
    pub fn submit_review(
        env: Env,
        reviewer: Address,
        reviewee: Address,
        rating: u32,
        comment: String,
    ) -> u64 {
        reviewer.require_auth();

        assert!(rating >= RATING_MIN, "Rating must be at least 1");
        assert!(rating <= RATING_MAX, "Rating must be at most 5");

        let dedup_key = DataKey::HasReviewed(reviewer.clone(), reviewee.clone());
        let already: bool = env.storage().instance().get(&dedup_key).unwrap_or(false);
        assert!(!already, "Reviewer has already reviewed this user");

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0);
        let id = count + 1;

        let review = Review {
            id,
            reviewer: reviewer.clone(),
            reviewee: reviewee.clone(),
            rating,
            comment,
            timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Review(id), &review);
        env.storage().instance().set(&DataKey::ReviewCount, &id);
        env.storage().instance().set(&dedup_key, &true);

        let target_key = DataKey::TargetReviews(reviewee.clone());
        let mut target_reviews: Vec<u64> = env
            .storage()
            .persistent()
            .get(&target_key)
            .unwrap_or_else(|| Vec::new(&env));
        target_reviews.push_back(id);
        env.storage().persistent().set(&target_key, &target_reviews);

        id
    }

    /// Return the review IDs for a given reviewee address.
    pub fn get_reviews_for_user(env: Env, reviewee: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::TargetReviews(reviewee))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Return the average rating × 100 for a reviewee (e.g. 3.0 → 300).
    ///
    /// Returns 0 if the user has no reviews.
    pub fn get_reputation(env: Env, user: Address) -> u32 {
        let review_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::TargetReviews(user))
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

        ((total * 100) / count as u64) as u32
    }

    /// Get a single review by its ID.
    pub fn get_review(env: Env, id: u64) -> Review {
        env.storage()
            .persistent()
            .get(&DataKey::Review(id))
            .expect("Review not found")
    }

    /// Return the total number of reviews ever submitted.
    pub fn review_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ReviewCount)
            .unwrap_or(0)
    }
}
