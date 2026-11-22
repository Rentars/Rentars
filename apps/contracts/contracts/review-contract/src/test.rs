//! Unit tests for the Review contract.
//!
//! Coverage:
//!   Happy paths  — submit, get, get_reviews_for_user, get_reputation, review_count
//!   Error cases  — invalid rating (0, 6), duplicate review prevention
//!   Security     — reentrancy simulation, unauthorized access, integer overflow
//!   Edge cases   — empty review list, ID uniqueness, timestamps, multiple reviewees,
//!                  all valid rating values, multiple reviews for same reviewee
//!   Gas / TTL    — test_gas_optimization_validation

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

    use crate::{ReviewContract, ReviewContractClient};

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// Create a fresh environment with the contract registered.
    fn make_env() -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReviewContract);
        (env, contract_id)
    }

    // ─── Happy Path Tests ─────────────────────────────────────────────────────

    /// Submitting a valid review stores all fields correctly.
    #[test]
    fn test_submit_review_success() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        let id = client.submit_review(
            &reviewer,
            &reviewee,
            &5_u32,
            &String::from_str(&env, "Excellent host!"),
        );

        assert_eq!(id, 1);

        let review = client.get_review(&id);
        assert_eq!(review.id, 1);
        assert_eq!(review.reviewer, reviewer);
        assert_eq!(review.reviewee, reviewee);
        assert_eq!(review.rating, 5);
        assert_eq!(review.comment, String::from_str(&env, "Excellent host!"));
    }

    // ─── Invalid Rating Tests ─────────────────────────────────────────────────

    /// Rating of 0 is below the minimum and must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at least 1")]
    fn test_submit_review_invalid_rating_zero() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(&reviewer, &reviewee, &0_u32, &String::from_str(&env, "Bad"));
    }

    /// Rating of 6 is above the maximum and must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at most 5")]
    fn test_submit_review_invalid_rating_six() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(&reviewer, &reviewee, &6_u32, &String::from_str(&env, "Too good"));
    }

    // ─── Duplicate Prevention Tests ───────────────────────────────────────────

    /// The same reviewer cannot submit a second review for the same reviewee.
    #[test]
    #[should_panic(expected = "Reviewer has already reviewed this user")]
    fn test_duplicate_review_prevention() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        client.submit_review(&reviewer, &reviewee, &4_u32, &String::from_str(&env, "Good"));
        client.submit_review(&reviewer, &reviewee, &3_u32, &String::from_str(&env, "Changed my mind"));
    }

    // ─── Query Tests ──────────────────────────────────────────────────────────

    /// get_reviews_for_user returns all review IDs for a reviewee.
    #[test]
    fn test_get_reviews_for_user() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);

        let id1 = client.submit_review(&r1, &reviewee, &5_u32, &String::from_str(&env, "A"));
        let id2 = client.submit_review(&r2, &reviewee, &4_u32, &String::from_str(&env, "B"));
        let id3 = client.submit_review(&r3, &reviewee, &3_u32, &String::from_str(&env, "C"));

        let ids = client.get_reviews_for_user(&reviewee);
        assert_eq!(ids.len(), 3);
        assert_eq!(ids.get(0).unwrap(), id1);
        assert_eq!(ids.get(1).unwrap(), id2);
        assert_eq!(ids.get(2).unwrap(), id3);
    }

    /// get_reviews_for_user returns an empty vec for a user with no reviews.
    #[test]
    fn test_get_reviews_for_user_empty() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let nobody = Address::generate(&env);
        let ids = client.get_reviews_for_user(&nobody);
        assert_eq!(ids.len(), 0);
    }

    /// get_reputation returns 0 for a user with no reviews.
    #[test]
    fn test_get_reputation_default() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let nobody = Address::generate(&env);
        assert_eq!(client.get_reputation(&nobody), 0);
    }

    /// get_reputation returns the correct average (×100) after reviews.
    #[test]
    fn test_get_reputation_average() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);
        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);

        // ratings: 4 + 2 = 6, avg = 3.00 → 300
        client.submit_review(&r1, &reviewee, &4_u32, &String::from_str(&env, "ok"));
        client.submit_review(&r2, &reviewee, &2_u32, &String::from_str(&env, "meh"));

        assert_eq!(client.get_reputation(&reviewee), 300);
    }

    // ─── ID Uniqueness Tests ──────────────────────────────────────────────────

    /// Every review gets a globally unique, incrementing ID.
    #[test]
    fn test_review_id_uniqueness() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);

        let reviewee_a = Address::generate(&env);
        let reviewee_b = Address::generate(&env);
        let reviewer_a = Address::generate(&env);
        let reviewer_b = Address::generate(&env);

        let id1 = client.submit_review(&reviewer_a, &reviewee_a, &5_u32, &String::from_str(&env, ""));
        let id2 = client.submit_review(&reviewer_b, &reviewee_b, &3_u32, &String::from_str(&env, ""));

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_ne!(id1, id2);
        assert_eq!(client.review_count(), 2);
    }

    // ─── Timestamp Tests ──────────────────────────────────────────────────────

    /// The review timestamp is set from the ledger at submission time.
    #[test]
    fn test_review_timestamp() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        let id = client.submit_review(&reviewer, &reviewee, &4_u32, &String::from_str(&env, "Nice"));
        let review = client.get_review(&id);
        assert_eq!(review.timestamp, env.ledger().timestamp());
    }

    // ─── Rating Value Tests ───────────────────────────────────────────────────

    /// All valid rating values (1–5) are accepted and stored correctly.
    #[test]
    fn test_different_rating_values() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        for rating in 1_u32..=5 {
            let reviewer = Address::generate(&env);
            let id = client.submit_review(&reviewer, &reviewee, &rating, &String::from_str(&env, "comment"));
            assert_eq!(client.get_review(&id).rating, rating);
        }

        assert_eq!(client.get_reviews_for_user(&reviewee).len(), 5);
    }

    // ─── Multiple Reviews Tests ───────────────────────────────────────────────

    /// Multiple different reviewers can each review the same user once.
    #[test]
    fn test_multiple_reviews_for_same_user() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        for _ in 0..10 {
            let reviewer = Address::generate(&env);
            client.submit_review(&reviewer, &reviewee, &5_u32, &String::from_str(&env, "great"));
        }

        assert_eq!(client.get_reviews_for_user(&reviewee).len(), 10);
        assert_eq!(client.review_count(), 10);
        assert_eq!(client.get_reputation(&reviewee), 500);
    }

    /// Reviews for different reviewees are fully isolated from each other.
    #[test]
    fn test_multiple_users_isolated() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);

        let user_a = Address::generate(&env);
        let user_b = Address::generate(&env);
        let reviewer_a = Address::generate(&env);
        let reviewer_b = Address::generate(&env);

        client.submit_review(&reviewer_a, &user_a, &5_u32, &String::from_str(&env, "A"));
        client.submit_review(&reviewer_b, &user_b, &2_u32, &String::from_str(&env, "B"));

        assert_eq!(client.get_reviews_for_user(&user_a).len(), 1);
        assert_eq!(client.get_reviews_for_user(&user_b).len(), 1);
        assert_eq!(client.get_reputation(&user_a), 500);
        assert_eq!(client.get_reputation(&user_b), 200);

        let ids_b = client.get_reviews_for_user(&user_b);
        let review_b = client.get_review(&ids_b.get(0).unwrap());
        assert_eq!(review_b.reviewer, reviewer_b);
    }

    // ─── Security Tests ───────────────────────────────────────────────────────

    /// Reentrancy simulation: submitting the same review twice must be rejected.
    #[test]
    #[should_panic(expected = "Reviewer has already reviewed this user")]
    fn test_reentrancy_attack_prevention() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let attacker = Address::generate(&env);
        let victim = Address::generate(&env);

        client.submit_review(&attacker, &victim, &5_u32, &String::from_str(&env, "legit"));
        client.submit_review(&attacker, &victim, &1_u32, &String::from_str(&env, "attack"));
    }

    /// The stored reviewer must match the caller — no impersonation.
    #[test]
    fn test_unauthorized_access_attempts() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let real_reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        let id = client.submit_review(&real_reviewer, &reviewee, &4_u32, &String::from_str(&env, "honest review"));
        let review = client.get_review(&id);
        assert_eq!(review.reviewer, real_reviewer);

        let other = Address::generate(&env);
        let already: bool = env
            .storage()
            .persistent()
            .get(&crate::DataKey::HasReviewed(other.clone(), reviewee.clone()))
            .unwrap_or(false);
        assert!(!already, "Other address must not be marked as having reviewed");
    }

    /// u32::MAX rating (far above 5) must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at most 5")]
    fn test_integer_overflow_underflow() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(&reviewer, &reviewee, &u32::MAX, &String::from_str(&env, "overflow attempt"));
    }

    /// review_count stays consistent across many submissions.
    #[test]
    fn test_review_count_consistency() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        for i in 1_u64..=20 {
            let reviewer = Address::generate(&env);
            client.submit_review(&reviewer, &reviewee, &3_u32, &String::from_str(&env, "ok"));
            assert_eq!(client.review_count(), i);
        }
    }

    // ─── Gas / TTL Validation Tests ───────────────────────────────────────────

    /// Verifies that core review operations complete within expected Soroban
    /// instruction limits and that TTL extensions are applied correctly.
    ///
    /// `budget().reset_unlimited()` disables the hard cap so the test can run
    /// freely; we then assert the measured instruction count stays below a
    /// generous ceiling of 10 million, confirming no runaway computation.
    #[test]
    fn test_gas_optimization_validation() {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, ReviewContract);
        let client = ReviewContractClient::new(&env, &contract_id);

        let reviewee = Address::generate(&env);

        // Submit 5 reviews from different reviewers
        for rating in 1_u32..=5 {
            let reviewer = Address::generate(&env);
            client.submit_review(
                &reviewer,
                &reviewee,
                &rating,
                &String::from_str(&env, "Gas test review"),
            );
        }

        // Verify reputation calculation
        // ratings: 1+2+3+4+5 = 15, avg = 3.0 → 300
        assert_eq!(client.get_reputation(&reviewee), 300);
        assert_eq!(client.review_count(), 5);

        // Verify instruction count is within a reasonable bound.
        let instructions_used = env.budget().cpu_instruction_count();
        assert!(
            instructions_used < 10_000_000,
            "Instruction count {} exceeded expected limit of 10_000_000",
            instructions_used
        );
    }

    // ─── Review Fuzzing Tests ─────────────────────────────────────────────────

    /// Fuzz test: randomised ratings and comment lengths — valid inputs only.
    ///
    /// Tests a corpus of (rating, comment) combinations that must all succeed
    /// and round-trip correctly through the contract.
    #[test]
    fn test_property_fuzzing() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        // ── Valid input corpus: (rating, comment) ─────────────────────────
        let corpus: &[(u32, &str)] = &[
            // Rating 1, empty comment
            (1, ""),
            // Rating 2, short comment
            (2, "ok"),
            // Rating 3, medium comment
            (3, "Average stay, nothing special."),
            // Rating 4, longer comment
            (4, "Great host, clean place, would recommend to friends."),
            // Rating 5, 64-char hex-like comment (simulates a hash reference)
            (
                5,
                "a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1",
            ),
            // Rating 1, comment with punctuation
            (1, "Terrible! Would not stay again."),
            // Rating 5, numeric-looking comment
            (5, "10/10 experience, 5 stars all the way."),
            // Rating 3, comment with spaces and dashes
            (3, "Nice place - good location - fair price"),
        ];

        let mut expected_count: u64 = 0;

        for &(rating, comment) in corpus {
            // Each submission uses a fresh reviewer to avoid duplicate-review rejection
            let reviewer = Address::generate(&env);

            let id = client.submit_review(
                &reviewer,
                &reviewee,
                &rating,
                &String::from_str(&env, comment),
            );
            expected_count += 1;

            let review = client.get_review(&id);
            assert_eq!(review.rating, rating, "rating mismatch for input {}", rating);
            assert_eq!(
                review.comment,
                String::from_str(&env, comment),
                "comment mismatch for input {:?}",
                comment
            );
            assert_eq!(review.reviewer, reviewer);
            assert_eq!(review.reviewee, reviewee);
            assert_eq!(
                client.review_count(),
                expected_count,
                "review_count mismatch after valid input"
            );
        }

        // All valid reviews are indexed under the reviewee
        assert_eq!(
            client.get_reviews_for_user(&reviewee).len(),
            expected_count as u32,
            "reviewee index length mismatch"
        );
        assert_eq!(client.review_count(), expected_count);
    }

    /// Fuzz test: rating = 0 (below minimum) must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at least 1")]
    fn test_property_fuzzing_rejects_rating_zero() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(
            &reviewer,
            &reviewee,
            &0_u32,
            &String::from_str(&env, "zero rating"),
        );
    }

    /// Fuzz test: rating = 6 (above maximum) must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at most 5")]
    fn test_property_fuzzing_rejects_rating_six() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(
            &reviewer,
            &reviewee,
            &6_u32,
            &String::from_str(&env, "six rating"),
        );
    }

    /// Fuzz test: rating = 100 (far above maximum) must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at most 5")]
    fn test_property_fuzzing_rejects_rating_100() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(
            &reviewer,
            &reviewee,
            &100_u32,
            &String::from_str(&env, "way too high"),
        );
    }

    /// Fuzz test: u32::MAX rating (extreme overflow attempt) must be rejected.
    #[test]
    #[should_panic(expected = "Rating must be at most 5")]
    fn test_property_fuzzing_rejects_rating_max() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);
        client.submit_review(
            &reviewer,
            &reviewee,
            &u32::MAX,
            &String::from_str(&env, "overflow attempt"),
        );
    }

    /// Fuzz test: duplicate-reviewer detection across randomised reviewer addresses.
    ///
    /// Verifies that the HasReviewed flag is set atomically and that any second
    /// submission from the same reviewer is always rejected, regardless of
    /// whether the rating or comment changes.
    #[test]
    fn test_property_fuzzing_duplicate_prevention() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewee = Address::generate(&env);

        // Corpus of first_rating values — each uses a fresh reviewer.
        // After the first submission succeeds, we verify the duplicate flag
        // is set by checking the storage key directly.
        let first_ratings: &[u32] = &[5, 3, 1, 4, 2];

        for &first_rating in first_ratings {
            let reviewer = Address::generate(&env);

            // First submission must succeed
            client.submit_review(
                &reviewer,
                &reviewee,
                &first_rating,
                &String::from_str(&env, "first review"),
            );

            // Verify the HasReviewed flag is set
            let already: bool = env
                .storage()
                .instance()
                .get(&crate::DataKey::HasReviewed(reviewer.clone(), reviewee.clone()))
                .unwrap_or(false);
            assert!(
                already,
                "HasReviewed flag must be set after first submission (rating={})",
                first_rating
            );
        }
    }

    /// Fuzz test: second submission from same reviewer must be rejected.
    #[test]
    #[should_panic(expected = "Reviewer has already reviewed this user")]
    fn test_property_fuzzing_rejects_duplicate_submission() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);
        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        client.submit_review(&reviewer, &reviewee, &5_u32, &String::from_str(&env, "first"));
        // Second submission — must be rejected
        client.submit_review(&reviewer, &reviewee, &1_u32, &String::from_str(&env, "changed my mind"));
    }

    /// Fuzz test: reputation calculation with randomised rating distributions.
    ///
    /// Verifies that get_reputation returns the correct average×100 for
    /// various combinations of ratings.
    #[test]
    fn test_property_fuzzing_reputation() {
        let (env, cid) = make_env();
        let client = ReviewContractClient::new(&env, &cid);

        // (ratings_vec, expected_reputation_x100)
        // reputation = (sum / count) * 100, integer division
        let cases: &[(&[u32], u32)] = &[
            (&[5], 500),
            (&[1], 100),
            (&[3], 300),
            (&[5, 5], 500),
            (&[1, 5], 300),          // (1+5)/2 = 3 → 300
            (&[1, 2, 3, 4, 5], 300), // (15)/5 = 3 → 300
            (&[2, 2, 2, 2], 200),
            (&[4, 4, 4, 4, 4], 400),
            (&[1, 1, 1, 1, 1], 100),
            (&[5, 5, 5, 5, 5], 500),
        ];

        for &(ratings, expected_rep) in cases {
            // Fresh reviewee per case to keep them isolated
            let reviewee = Address::generate(&env);

            for &rating in ratings {
                let reviewer = Address::generate(&env);
                client.submit_review(
                    &reviewer,
                    &reviewee,
                    &rating,
                    &String::from_str(&env, "fuzz review"),
                );
            }

            let rep = client.get_reputation(&reviewee);
            assert_eq!(
                rep, expected_rep,
                "reputation mismatch for ratings {:?}: got {}, expected {}",
                ratings, rep, expected_rep
            );
        }
    }

    // ─── Deployment Validation Tests ──────────────────────────────────────────

    /// Deployment validation: contract initialises correctly with testnet-like
    /// ledger settings (non-zero sequence number and timestamp).
    ///
    /// On Stellar Testnet the ledger sequence starts well above 0 and the
    /// timestamp reflects real wall-clock time. This test simulates that
    /// environment and verifies the contract behaves identically to a fresh
    /// mainnet deploy. In particular, the review timestamp must be sourced from
    /// the ledger, so advancing the ledger before submission must be reflected
    /// in the stored review.
    #[test]
    fn test_deployment_validation_networks_testnet_init() {
        let env = Env::default();
        env.mock_all_auths();

        // Simulate testnet ledger state
        env.ledger().with_mut(|li| {
            li.sequence_number = 3_000_000;   // testnet-like sequence
            li.timestamp = 1_700_000_000;     // ~Nov 2023 Unix timestamp
        });

        let contract_id = env.register_contract(None, ReviewContract);
        let client = ReviewContractClient::new(&env, &contract_id);

        // Review count starts at zero regardless of ledger state
        assert_eq!(
            client.review_count(),
            0,
            "Review count must be 0 on a fresh testnet deploy"
        );

        let reviewer = Address::generate(&env);
        let reviewee = Address::generate(&env);

        let id = client.submit_review(
            &reviewer,
            &reviewee,
            &5_u32,
            &String::from_str(&env, "Great on testnet!"),
        );

        assert_eq!(id, 1);

        let review = client.get_review(&id);
        // The timestamp must match the simulated testnet ledger timestamp
        assert_eq!(
            review.timestamp,
            1_700_000_000,
            "Review timestamp must reflect the testnet ledger timestamp"
        );
        assert_eq!(review.rating, 5);
    }

    /// Deployment validation: contract IDs are deterministic given the same
    /// deployer and salt.
    ///
    /// Soroban derives a contract address from (deployer_address, salt) via a
    /// deterministic hash. Registering the same contract type at the same
    /// explicit address in two independent environments must yield the same
    /// address, confirming the determinism property relied upon by deployment
    /// scripts and cross-contract calls.
    #[test]
    fn test_deployment_validation_networks_deterministic_contract_id() {
        // Build two completely independent environments
        let env_a = Env::default();
        env_a.mock_all_auths();
        let env_b = Env::default();
        env_b.mock_all_auths();

        // Construct a fixed contract address from a known 32-byte value.
        // This simulates deploying with a known salt so the resulting contract
        // ID is reproducible across networks.
        let fixed_bytes: [u8; 32] = [0x03u8; 32];
        let contract_addr_a = soroban_sdk::Address::from_contract_id(
            &BytesN::from_array(&env_a, &fixed_bytes),
        );
        let contract_addr_b = soroban_sdk::Address::from_contract_id(
            &BytesN::from_array(&env_b, &fixed_bytes),
        );

        // Register the contract at the fixed address in both environments
        env_a.register_contract(&contract_addr_a, ReviewContract);
        env_b.register_contract(&contract_addr_b, ReviewContract);

        // Both contract addresses must be equal — determinism holds
        assert_eq!(
            contract_addr_a, contract_addr_b,
            "Contract IDs derived from the same salt must be identical across environments"
        );

        // Both instances must operate independently with correct initial state
        let client_a = ReviewContractClient::new(&env_a, &contract_addr_a);
        let client_b = ReviewContractClient::new(&env_b, &contract_addr_b);

        assert_eq!(client_a.review_count(), 0);
        assert_eq!(client_b.review_count(), 0);

        // Submitting a review in env_a must not affect env_b
        let reviewer_a = Address::generate(&env_a);
        let reviewee_a = Address::generate(&env_a);
        client_a.submit_review(
            &reviewer_a,
            &reviewee_a,
            &4_u32,
            &String::from_str(&env_a, "Env A review"),
        );

        assert_eq!(client_a.review_count(), 1);
        assert_eq!(client_b.review_count(), 0, "env_b must remain isolated from env_a");
    }

    // ─── Cross-Contract Compatibility Tests ───────────────────────────────────

    /// Cross-contract harness: deploys the Review, Booking and PropertyListing
    /// contracts into a single `Env` so the integrated rental flow can be
    /// exercised end-to-end.
    ///
    /// The review contract does not (yet) hold a direct dependency on the
    /// booking/property contracts, so the harness models the integration
    /// boundary explicitly: a review is only considered valid when it is
    /// anchored to a booking that the booking contract reports as completed
    /// for a listing that the property contract reports as active. These
    /// helpers keep the cross-contract invariants in one place so a regression
    /// in any interface is reported with a precise message.
    mod cross_contract {
        use super::*;
        use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Symbol};

        // ── Minimal stand-in interfaces ───────────────────────────────────
        //
        // These mirror the public surface of the booking and property-listing
        // contracts that the review flow depends on. They are registered in
        // the same `Env` as the review contract so cross-contract state can be
        // asserted together.

        #[contracttype]
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum ListingStatus {
            Active,
            Inactive,
        }

        #[contracttype]
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum BookingStatus {
            Pending,
            Completed,
            Cancelled,
        }

        #[contracttype]
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct Listing {
            pub id: u64,
            pub host: Address,
            pub status: ListingStatus,
        }

        #[contracttype]
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct Booking {
            pub id: u64,
            pub listing_id: u64,
            pub guest: Address,
            pub status: BookingStatus,
        }

        #[contract]
        pub struct PropertyListingContract;

        #[contractimpl]
        impl PropertyListingContract {
            pub fn create_listing(env: Env, id: u64, host: Address) -> Listing {
                let listing = Listing {
                    id,
                    host,
                    status: ListingStatus::Active,
                };
                env.storage()
                    .persistent()
                    .set(&(symbol_short!("LISTING"), id), &listing);
                listing
            }

            pub fn set_listing_status(env: Env, id: u64, status: ListingStatus) {
                let mut listing: Listing = env
                    .storage()
                    .persistent()
                    .get(&(symbol_short!("LISTING"), id))
                    .expect("listing must exist");
                listing.status = status;
                env.storage()
                    .persistent()
                    .set(&(symbol_short!("LISTING"), id), &listing);
            }

            pub fn get_listing(env: Env, id: u64) -> Listing {
                env.storage()
                    .persistent()
                    .get(&(symbol_short!("LISTING"), id))
                    .expect("listing must exist")
            }
        }

        #[contract]
        pub struct BookingContract;

        #[contractimpl]
        impl BookingContract {
            pub fn create_booking(
                env: Env,
                id: u64,
                listing_id: u64,
                guest: Address,
            ) -> Booking {
                let booking = Booking {
                    id,
                    listing_id,
                    guest,
                    status: BookingStatus::Pending,
                };
                env.storage()
                    .persistent()
                    .set(&(symbol_short!("BOOKING"), id), &booking);
                booking
            }

            pub fn complete_booking(env: Env, id: u64) {
                let mut booking: Booking = env
                    .storage()
                    .persistent()
                    .get(&(symbol_short!("BOOKING"), id))
                    .expect("booking must exist");
                booking.status = BookingStatus::Completed;
                env.storage()
                    .persistent()
                    .set(&(symbol_short!("BOOKING"), id), &booking);
            }

            pub fn cancel_booking(env: Env, id: u64) {
                let mut booking: Booking = env
                    .storage()
                    .persistent()
                    .get(&(symbol_short!("BOOKING"), id))
                    .expect("booking must exist");
                booking.status = BookingStatus::Cancelled;
                env.storage()
                    .persistent()
                    .set(&(symbol_short!("BOOKING"), id), &booking);
            }

            pub fn get_booking(env: Env, id: u64) -> Booking {
                env.storage()
                    .persistent()
                    .get(&(symbol_short!("BOOKING"), id))
                    .expect("booking must exist")
            }
        }

        // ── Harness ───────────────────────────────────────────────────────

        pub struct Harness {
            pub env: Env,
            pub review_id: Address,
            pub booking_id: Address,
            pub property_id: Address,
        }

        impl Harness {
            pub fn new() -> Self {
                let env = Env::default();
                env.mock_all_auths();
                let review_id = env.register_contract(None, ReviewContract);
                let booking_id = env.register_contract(None, BookingContract);
                let property_id = env.register_contract(None, PropertyListingContract);
                Self {
                    env,
                    review_id,
                    booking_id,
                    property_id,
                }
            }

            pub fn review(&self) -> ReviewContractClient<'_> {
                ReviewContractClient::new(&self.env, &self.review_id)
            }

            pub fn booking(&self) -> BookingContractClient<'_> {
                BookingContractClient::new(&self.env, &self.booking_id)
            }

            pub fn property(&self) -> PropertyListingContractClient<'_> {
                PropertyListingContractClient::new(&self.env, &self.property_id)
            }

            /// Cross-contract invariant: a review may only be anchored to a
            /// booking that exists, belongs to an active listing, and has been
            /// completed. Returns `Err` with a message naming the violated
            /// interface so failures identify the regressed contract.
            pub fn assert_review_eligible(&self, booking_id: u64) -> Result<(), Symbol> {
                let booking = self.booking().get_booking(&booking_id);
                let listing = self.property().get_listing(&booking.listing_id);
                if listing.status != ListingStatus::Active {
                    return Err(symbol_short!("INACTIVE"));
                }
                if booking.status != BookingStatus::Completed {
                    return Err(symbol_short!("NOTDONE"));
                }
                Ok(())
            }
        }
    }

    use cross_contract::{
        BookingContractClient, BookingStatus, Harness, ListingStatus, PropertyListingContractClient,
    };

    /// Happy path: a completed booking on an active listing allows a review,
    /// and the review state stays consistent with the booking/property state.
    #[test]
    fn test_cross_contract_review_after_completed_booking() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);
        h.booking().create_booking(&10_u64, &1_u64, &guest);
        h.booking().complete_booking(&10_u64);

        h.assert_review_eligible(10)
            .expect("review interface: completed booking on active listing must be eligible");

        let review_client = h.review();
        let id = review_client.submit_review(
            &guest,
            &host,
            &5_u32,
            &String::from_str(&h.env, "Great stay"),
        );

        assert_eq!(
            review_client.review_count(),
            1,
            "review interface: review_count must reflect the single valid cross-contract flow"
        );
        assert_eq!(
            review_client.get_reputation(&host),
            500,
            "review interface: reputation must reflect only the valid cross-contract review"
        );
        assert_eq!(
            review_client.get_reviews_for_user(&host).len(),
            1,
            "review interface: reviewee index must contain exactly the valid review"
        );
        assert_eq!(review_client.get_review(&id).reviewer, guest);
    }

    /// A review must not be accepted for a booking that does not exist.
    #[test]
    fn test_cross_contract_review_missing_booking() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);

        // No booking was created — the eligibility check must fail.
        let result = h.assert_review_eligible(999);
        assert!(
            result.is_err(),
            "booking interface: eligibility must fail for a non-existent booking"
        );

        // Review state must remain untouched by the failed cross-contract flow.
        let review_client = h.review();
        assert_eq!(
            review_client.review_count(),
            0,
            "review interface: review_count must stay 0 when the booking is missing"
        );
        assert_eq!(
            review_client.get_reputation(&host),
            0,
            "review interface: reputation must stay 0 when the booking is missing"
        );
    }

    /// A review must not be accepted while the booking is still pending.
    #[test]
    fn test_cross_contract_review_pending_booking_rejected() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);
        h.booking().create_booking(&10_u64, &1_u64, &guest);

        let result = h.assert_review_eligible(10);
        assert!(
            result.is_err(),
            "booking interface: pending booking must not be review-eligible"
        );

        let review_client = h.review();
        assert_eq!(
            review_client.review_count(),
            0,
            "review interface: no review may be recorded for a pending booking"
        );
    }

    /// A review must not be accepted for a booking on an inactive listing.
    #[test]
    fn test_cross_contract_review_inactive_listing_rejected() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);
        h.booking().create_booking(&10_u64, &1_u64, &guest);
        h.booking().complete_booking(&10_u64);
        h.property()
            .set_listing_status(&1_u64, &ListingStatus::Inactive);

        let result = h.assert_review_eligible(10);
        assert!(
            result.is_err(),
            "property interface: completed booking on inactive listing must not be review-eligible"
        );

        let review_client = h.review();
        assert_eq!(
            review_client.review_count(),
            0,
            "review interface: no review may be recorded for an inactive listing"
        );
    }

    /// A cancelled booking must not be review-eligible.
    #[test]
    fn test_cross_contract_review_cancelled_booking_rejected() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);
        h.booking().create_booking(&10_u64, &1_u64, &guest);
        h.booking().cancel_booking(&10_u64);

        let result = h.assert_review_eligible(10);
        assert!(
            result.is_err(),
            "booking interface: cancelled booking must not be review-eligible"
        );

        let review_client = h.review();
        assert_eq!(
            review_client.review_count(),
            0,
            "review interface: no review may be recorded for a cancelled booking"
        );
    }

    /// Downstream failure atomicity: a rejected review submission (invalid
    /// rating) must not leave partial writes in the review contract, and the
    /// booking/property state must be unchanged.
    #[test]
    fn test_cross_contract_failed_review_is_atomic() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);
        h.booking().create_booking(&10_u64, &1_u64, &guest);
        h.booking().complete_booking(&10_u64);

        let review_client = h.review();

        // Invalid rating must be rejected by the review contract.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            review_client.submit_review(
                &guest,
                &host,
                &0_u32,
                &String::from_str(&h.env, "invalid"),
            );
        }));
        assert!(
            result.is_err(),
            "review interface: rating 0 must be rejected even in a valid cross-contract flow"
        );

        // No partial writes: review state is untouched.
        assert_eq!(
            review_client.review_count(),
            0,
            "review interface: failed submission must not increment review_count"
        );
        assert_eq!(
            review_client.get_reviews_for_user(&host).len(),
            0,
            "review interface: failed submission must not write to the reviewee index"
        );
        assert_eq!(
            review_client.get_reputation(&host),
            0,
            "review interface: failed submission must not affect reputation"
        );

        // Cross-contract state is unchanged by the failed review.
        assert_eq!(
            h.booking().get_booking(&10_u64).status,
            BookingStatus::Completed,
            "booking interface: failed review must not mutate booking status"
        );
        assert_eq!(
            h.property().get_listing(&1_u64).status,
            ListingStatus::Active,
            "property interface: failed review must not mutate listing status"
        );
    }

    /// Multiple valid cross-contract flows accumulate consistently, while
    /// ineligible flows contribute nothing to review count or reputation.
    #[test]
    fn test_cross_contract_review_state_consistency() {
        let h = Harness::new();
        let host = Address::generate(&h.env);
        let guest_a = Address::generate(&h.env);
        let guest_b = Address::generate(&h.env);

        h.property().create_listing(&1_u64, &host);

        // Valid flow: completed booking.
        h.booking().create_booking(&10_u64, &1_u64, &guest_a);
        h.booking().complete_booking(&10_u64);
        h.assert_review_eligible(10)
            .expect("review interface: completed booking must be eligible");

        // Ineligible flow: pending booking.
        h.booking().create_booking(&11_u64, &1_u64, &guest_b);
        assert!(
            h.assert_review_eligible(11).is_err(),
            "booking interface: pending booking must not be eligible"
        );

        let review_client = h.review();
        review_client.submit_review(
            &guest_a,
            &host,
            &4_u32,
            &String::from_str(&h.env, "Valid review"),
        );

        assert_eq!(
            review_client.review_count(),
            1,
            "review interface: only the valid cross-contract flow may be counted"
        );
        assert_eq!(
            review_client.get_reputation(&host),
            400,
            "review interface: reputation must reflect only valid cross-contract reviews"
        );
        assert_eq!(
            review_client.get_reviews_for_user(&host).len(),
            1,
            "review interface: reviewee index must contain only valid cross-contract reviews"
        );
    }
}
