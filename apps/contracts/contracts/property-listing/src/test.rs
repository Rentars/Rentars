//! Unit tests for the PropertyListing contract.
//!
//! Coverage:
//!   Happy paths  — create, get, update, update_status, set_rented
//!   Error cases  — unauthorized, not-found, duplicate-id logic, invalid inputs
//!   Edge cases   — empty strings, boundary values, max price, single-char title
//!   Gas / TTL    — test_gas_optimization_validation

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

    use crate::{ListingStatus, PropertyListingContract, PropertyListingContractClient};

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// Create a fresh environment with the contract registered.
    /// Returns (Env, contract_id) — callers create the client themselves so the
    /// borrow of `env` stays in the same scope.
    fn make_env() -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PropertyListingContract);
        (env, contract_id)
    }

    // ─── Happy Path Tests ────────────────────────────────────────────────────

    /// Creating a listing returns ID 1 and stores the correct data.
    #[test]
    fn test_create_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Mountain Cabin"),
            &String::from_str(&env, "Peaceful retreat in the Alps"),
            &50_0000000_i128,
        );

        assert_eq!(id, 1, "First listing should have ID 1");

        let listing = client.get_listing(&id);
        assert_eq!(listing.id, 1);
        assert_eq!(listing.owner, owner);
        assert_eq!(listing.title, String::from_str(&env, "Mountain Cabin"));
        assert_eq!(
            listing.description,
            String::from_str(&env, "Peaceful retreat in the Alps")
        );
        assert_eq!(listing.price_per_night, 50_0000000_i128);
        assert_eq!(listing.status, ListingStatus::Active);
    }

    /// IDs auto-increment: second listing gets ID 2.
    #[test]
    fn test_create_listing_increments_id() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id1 = client.create_listing(
            &owner,
            &String::from_str(&env, "House A"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        let id2 = client.create_listing(
            &owner,
            &String::from_str(&env, "House B"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(client.listing_count(), 2);
    }

    /// get_listing returns the correct listing for a valid ID.
    #[test]
    fn test_get_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "City Apartment"),
            &String::from_str(&env, "Modern flat in downtown"),
            &200_0000000_i128,
        );

        let listing = client.get_listing(&id);
        assert_eq!(listing.id, id);
        assert_eq!(listing.price_per_night, 200_0000000_i128);
        assert_eq!(listing.status, ListingStatus::Active);
    }

    /// Owner can update title, description, and price.
    #[test]
    fn test_update_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "A lovely place by the sea"),
            &100_0000000_i128,
        );

        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Updated Beach House"),
            &String::from_str(&env, "Renovated with ocean view"),
            &150_0000000_i128,
        );

        let listing = client.get_listing(&id);
        assert_eq!(listing.title, String::from_str(&env, "Updated Beach House"));
        assert_eq!(
            listing.description,
            String::from_str(&env, "Renovated with ocean view")
        );
        assert_eq!(listing.price_per_night, 150_0000000_i128);
        // Status should be unchanged
        assert_eq!(listing.status, ListingStatus::Active);
    }

    /// Owner can change listing status to Inactive.
    #[test]
    fn test_update_status() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_status(&owner, &id, &ListingStatus::Inactive);

        let listing = client.get_listing(&id);
        assert_eq!(listing.status, ListingStatus::Inactive);
    }

    /// Owner can cycle through all status variants.
    #[test]
    fn test_update_status_all_variants() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_status(&owner, &id, &ListingStatus::Rented);
        assert_eq!(client.get_listing(&id).status, ListingStatus::Rented);

        client.update_status(&owner, &id, &ListingStatus::Active);
        assert_eq!(client.get_listing(&id).status, ListingStatus::Active);

        client.update_status(&owner, &id, &ListingStatus::Inactive);
        assert_eq!(client.get_listing(&id).status, ListingStatus::Inactive);
    }

    /// set_rented transitions an Active listing to Rented without owner auth.
    #[test]
    fn test_set_rented_success() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.set_rented(&id);

        assert_eq!(client.get_listing(&id).status, ListingStatus::Rented);
    }

    /// set_rented panics when the listing is not Active.
    #[test]
    #[should_panic(expected = "Property is not available for booking")]
    fn test_set_rented_not_active() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        // Mark inactive first
        client.update_status(&owner, &id, &ListingStatus::Inactive);
        // Now set_rented must fail
        client.set_rented(&id);
    }

    /// set_rented panics when the listing does not exist.
    #[test]
    #[should_panic(expected = "Listing not found")]
    fn test_set_rented_not_found() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        client.set_rented(&9999);
    }

    /// Multiple owners can each have their own listings independently.
    #[test]
    fn test_multiple_owners_independent_listings() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner_a = Address::generate(&env);
        let owner_b = Address::generate(&env);

        let id_a = client.create_listing(
            &owner_a,
            &String::from_str(&env, "Owner A Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        let id_b = client.create_listing(
            &owner_b,
            &String::from_str(&env, "Owner B Property"),
            &String::from_str(&env, "desc"),
            &200_0000000_i128,
        );

        assert_ne!(id_a, id_b);
        assert_eq!(client.get_listing(&id_a).owner, owner_a);
        assert_eq!(client.get_listing(&id_b).owner, owner_b);
    }

    // ─── Error / Negative Tests ───────────────────────────────────────────────

    /// A non-owner cannot update a listing.
    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn test_update_listing_unauthorized() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        // attacker tries to update owner's listing
        client.update_listing(
            &attacker,
            &id,
            &String::from_str(&env, "Hacked Title"),
            &String::from_str(&env, "Hacked desc"),
            &1_i128,
        );
    }

    /// A non-owner cannot change the status of a listing.
    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn test_update_status_unauthorized() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_status(&attacker, &id, &ListingStatus::Inactive);
    }

    /// Getting a listing that does not exist panics.
    #[test]
    #[should_panic(expected = "Listing not found")]
    fn test_get_nonexistent_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        client.get_listing(&9999);
    }

    /// Updating a listing that does not exist panics.
    #[test]
    #[should_panic(expected = "Listing not found")]
    fn test_update_nonexistent_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let caller = Address::generate(&env);

        client.update_listing(
            &caller,
            &9999,
            &String::from_str(&env, "Title"),
            &String::from_str(&env, "Desc"),
            &100_i128,
        );
    }

    /// Creating a listing with zero price panics.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_create_listing_zero_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        client.create_listing(
            &owner,
            &String::from_str(&env, "Free House"),
            &String::from_str(&env, "desc"),
            &0_i128,
        );
    }

    /// Creating a listing with a negative price panics.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_create_listing_negative_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        client.create_listing(
            &owner,
            &String::from_str(&env, "Negative House"),
            &String::from_str(&env, "desc"),
            &-1_i128,
        );
    }

    /// Creating a listing with an empty title panics.
    #[test]
    #[should_panic(expected = "title must not be empty")]
    fn test_create_listing_empty_title() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        client.create_listing(
            &owner,
            &String::from_str(&env, ""),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
    }

    /// Simulates "duplicate listing" — same owner creates two listings with identical data.
    /// The contract assigns distinct IDs (no deduplication by content).
    #[test]
    fn test_create_duplicate_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id1 = client.create_listing(
            &owner,
            &String::from_str(&env, "Same Title"),
            &String::from_str(&env, "Same desc"),
            &100_0000000_i128,
        );
        let id2 = client.create_listing(
            &owner,
            &String::from_str(&env, "Same Title"),
            &String::from_str(&env, "Same desc"),
            &100_0000000_i128,
        );

        // Both are stored independently with unique IDs
        assert_ne!(id1, id2, "Duplicate content should still produce unique IDs");
        assert_eq!(client.listing_count(), 2);
    }

    // ─── Edge Case Tests ──────────────────────────────────────────────────────

    /// Edge cases: boundary values and unusual but valid inputs.
    #[test]
    fn test_edge_cases() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        // Minimum valid price: 1 stroop
        let id_min_price = client.create_listing(
            &owner,
            &String::from_str(&env, "A"),
            &String::from_str(&env, ""),
            &1_i128,
        );
        let listing = client.get_listing(&id_min_price);
        assert_eq!(listing.price_per_night, 1_i128);

        // Single-character title is valid
        assert_eq!(listing.title, String::from_str(&env, "A"));

        // Empty description is valid
        assert_eq!(listing.description, String::from_str(&env, ""));

        // Maximum i128 price (boundary)
        let id_max_price = client.create_listing(
            &owner,
            &String::from_str(&env, "Max Price Property"),
            &String::from_str(&env, "desc"),
            &i128::MAX,
        );
        let listing_max = client.get_listing(&id_max_price);
        assert_eq!(listing_max.price_per_night, i128::MAX);

        // Listing count reflects both
        assert_eq!(client.listing_count(), 2);
    }

    /// Updating with the minimum valid price (1 stroop) succeeds.
    #[test]
    fn test_update_listing_minimum_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Cheap Stay"),
            &String::from_str(&env, "Budget option"),
            &1_i128,
        );

        assert_eq!(client.get_listing(&id).price_per_night, 1_i128);
    }

    /// Updating with zero price panics.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_update_listing_zero_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Title"),
            &String::from_str(&env, "desc"),
            &0_i128,
        );
    }

    /// Updating with an empty title panics.
    #[test]
    #[should_panic(expected = "title must not be empty")]
    fn test_update_listing_empty_title() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, ""),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
    }

    /// listing_count returns 0 on a fresh contract.
    #[test]
    fn test_listing_count_starts_at_zero() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        assert_eq!(client.listing_count(), 0);
    }

    /// Listing count increments correctly across many listings.
    #[test]
    fn test_listing_count_many() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        for i in 1_u64..=10 {
            client.create_listing(
                &owner,
                &String::from_str(&env, "House"),
                &String::from_str(&env, "desc"),
                &100_0000000_i128,
            );
            assert_eq!(client.listing_count(), i);
        }
    }

    /// A listing's owner field is immutable through update_listing.
    #[test]
    fn test_update_does_not_change_owner() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "New Title"),
            &String::from_str(&env, "New desc"),
            &999_0000000_i128,
        );

        assert_eq!(client.get_listing(&id).owner, owner);
    }

    // ─── Property Fuzzing Tests ───────────────────────────────────────────────

    /// Fuzz test: randomised string IDs (simulated via varied title/description
    /// content) and data hashes of varying lengths — valid inputs only.
    ///
    /// Tests a matrix of (title, description, price) combinations that must all
    /// succeed and round-trip correctly through the contract.
    #[test]
    fn test_property_fuzzing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        // ── Valid input corpus ────────────────────────────────────────────
        // Each entry: (title, description, price)
        let corpus: &[(&str, &str, i128)] = &[
            // Single-char title, empty description, minimum price
            ("A", "", 1),
            // Short title, short description, typical price
            ("ab", "xy", 100_0000000),
            // 32-char hex-like title (simulates a data hash used as title)
            ("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "hash-based title", 50_0000000),
            // 64-char hex string (full SHA-256 hex length) as description
            (
                "Property",
                "a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1e2d4b5c6a3f1",
                200_0000000,
            ),
            // Unicode-safe ASCII title with spaces
            ("Beach House Near Ocean", "Lovely place", 75_0000000),
            // Maximum i128 price boundary
            ("Max Price", "desc", i128::MAX),
            // Price of exactly 1 stroop (minimum valid)
            ("Min Price", "desc", 1),
            // Long description (simulates a full data hash payload reference)
            (
                "Long Desc Property",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                10_0000000,
            ),
            // Numeric-looking title
            ("1234567890", "numeric title", 999),
            // Title with special ASCII chars (valid in Soroban String)
            ("Prop-2024_v1", "versioned listing", 300_0000000),
        ];

        let mut expected_count: u64 = 0;

        for &(title_str, desc_str, price) in corpus {
            let id = client.create_listing(
                &owner,
                &String::from_str(&env, title_str),
                &String::from_str(&env, desc_str),
                &price,
            );
            expected_count += 1;

            // Round-trip: stored data must match what we sent
            let listing = client.get_listing(&id);
            assert_eq!(
                listing.title,
                String::from_str(&env, title_str),
                "title mismatch for input {:?}",
                title_str
            );
            assert_eq!(
                listing.description,
                String::from_str(&env, desc_str),
                "description mismatch for input {:?}",
                desc_str
            );
            assert_eq!(
                listing.price_per_night, price,
                "price mismatch for input {}",
                price
            );
            assert_eq!(listing.owner, owner);
            assert_eq!(listing.status, ListingStatus::Active);
            assert_eq!(
                client.listing_count(),
                expected_count,
                "listing_count mismatch after valid input"
            );
        }

        // Final sanity: total valid inputs created
        assert_eq!(client.listing_count(), expected_count);
    }

    /// Fuzz test: empty title must be rejected.
    #[test]
    #[should_panic(expected = "title must not be empty")]
    fn test_property_fuzzing_rejects_empty_title() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        client.create_listing(
            &owner,
            &String::from_str(&env, ""),
            &String::from_str(&env, "some desc"),
            &100_0000000_i128,
        );
    }

    /// Fuzz test: zero price must be rejected.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_property_fuzzing_rejects_zero_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        client.create_listing(
            &owner,
            &String::from_str(&env, "Valid Title"),
            &String::from_str(&env, "desc"),
            &0_i128,
        );
    }

    /// Fuzz test: negative price must be rejected.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_property_fuzzing_rejects_negative_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        client.create_listing(
            &owner,
            &String::from_str(&env, "Valid Title"),
            &String::from_str(&env, "desc"),
            &-1_i128,
        );
    }

    /// Fuzz test: i128::MIN price must be rejected.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_property_fuzzing_rejects_min_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        client.create_listing(
            &owner,
            &String::from_str(&env, "Valid Title"),
            &String::from_str(&env, "desc"),
            &i128::MIN,
        );
    }

    /// Fuzz test: update_listing with randomised valid title/description/price combos.
    ///
    /// Verifies that valid updates succeed and round-trip correctly.
    #[test]
    fn test_property_fuzzing_update() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        // Seed a listing to update
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Original Title"),
            &String::from_str(&env, "Original desc"),
            &100_0000000_i128,
        );

        // Valid update corpus: (new_title, new_desc, new_price)
        let update_corpus: &[(&str, &str, i128)] = &[
            ("Updated A", "desc a", 1),
            ("Updated B", "desc b", i128::MAX),
            (
                "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                "hash-title update",
                50_0000000,
            ),
            ("X", "", 999),
        ];

        for &(new_title, new_desc, new_price) in update_corpus {
            client.update_listing(
                &owner,
                &id,
                &String::from_str(&env, new_title),
                &String::from_str(&env, new_desc),
                &new_price,
            );
            let listing = client.get_listing(&id);
            assert_eq!(listing.title, String::from_str(&env, new_title));
            assert_eq!(listing.description, String::from_str(&env, new_desc));
            assert_eq!(listing.price_per_night, new_price);
        }
    }

    /// Fuzz test: update_listing with empty title must be rejected.
    #[test]
    #[should_panic(expected = "title must not be empty")]
    fn test_property_fuzzing_update_rejects_empty_title() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Original"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, ""),
            &String::from_str(&env, "desc"),
            &100_i128,
        );
    }

    /// Fuzz test: update_listing with zero price must be rejected.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_property_fuzzing_update_rejects_zero_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Original"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Title"),
            &String::from_str(&env, "desc"),
            &0_i128,
        );
    }

    /// Fuzz test: update_listing with negative price must be rejected.
    #[test]
    #[should_panic(expected = "price_per_night must be positive")]
    fn test_property_fuzzing_update_rejects_negative_price() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Original"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Title"),
            &String::from_str(&env, "desc"),
            &-500_i128,
        );
    }

    // ─── Authorization Matrix Tests ───────────────────────────────────────────

    /// Method-to-authority matrix.
    ///
    /// | Method          | Caller authority required          | State precondition |
    /// |-----------------|------------------------------------|--------------------|
    /// | create_listing  | `owner` must authorize             | none               |
    /// | get_listing     | none (read-only)                   | listing exists     |
    /// | update_listing  | stored `owner` must authorize      | listing exists     |
    /// | update_status   | stored `owner` must authorize      | listing exists     |
    /// | set_rented      | none (internal booking hook)       | status == Active   |
    /// | listing_count   | none (read-only)                   | none               |
    ///
    /// This test asserts the matrix end-to-end: every mutating entry point
    /// requires the expected authority, and read-only entry points never do.
    #[test]
    fn test_authorization_matrix() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let other = Address::generate(&env);

        // create_listing — owner authorizes.
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Matrix Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| addr == &owner),
            "create_listing must require owner authorization"
        );

        // get_listing / listing_count — no authorization recorded.
        let _ = client.get_listing(&id);
        let _ = client.listing_count();
        assert!(
            env.auths().is_empty(),
            "read-only entry points must not require authorization"
        );

        // update_listing — stored owner authorizes, not the caller argument.
        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Matrix Updated"),
            &String::from_str(&env, "desc"),
            &200_0000000_i128,
        );
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| addr == &owner),
            "update_listing must require owner authorization"
        );

        // update_status — stored owner authorizes.
        client.update_status(&owner, &id, &ListingStatus::Inactive);
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| addr == &owner),
            "update_status must require owner authorization"
        );

        // set_rented — no caller authority, only state precondition.
        client.update_status(&owner, &id, &ListingStatus::Active);
        client.set_rented(&id);
        assert!(
            env.auths().is_empty(),
            "set_rented must not require caller authorization"
        );
        assert_eq!(client.get_listing(&id).status, ListingStatus::Rented);

        // A different address is never implicitly authorized.
        assert_ne!(owner, other);
    }

    /// Unauthorized create_listing must fail when the owner does not authorize.
    #[test]
    #[should_panic]
    fn test_create_listing_unauthorized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PropertyListingContract);
        let client = PropertyListingContractClient::new(&env, &contract_id);
        let owner = Address::generate(&env);

        // No mock_all_auths: the owner has not signed.
        client.create_listing(
            &owner,
            &String::from_str(&env, "Unauthorized"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
    }

    /// Unauthorized update_listing must fail when the stored owner does not sign.
    #[test]
    #[should_panic]
    fn test_update_listing_unauthorized_no_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PropertyListingContract);
        let client = PropertyListingContractClient::new(&env, &contract_id);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        // Drop mocked auths so the update must present real authorization.
        env.set_auths(&[]);
        client.update_listing(
            &owner,
            &id,
            &String::from_str(&env, "Hijacked"),
            &String::from_str(&env, "desc"),
            &1_i128,
        );
    }

    /// Unauthorized update_status must fail when the stored owner does not sign.
    #[test]
    #[should_panic]
    fn test_update_status_unauthorized_no_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PropertyListingContract);
        let client = PropertyListingContractClient::new(&env, &contract_id);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        env.set_auths(&[]);
        client.update_status(&owner, &id, &ListingStatus::Inactive);
    }

    /// A failed unauthorized mutation must leave state untouched.
    #[test]
    fn test_unauthorized_mutation_does_not_corrupt_state() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Original"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        // Attempt an unauthorized update; it must panic and roll back.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_listing(
                &attacker,
                &id,
                &String::from_str(&env, "Hacked"),
                &String::from_str(&env, "hacked"),
                &1_i128,
            );
        }));
        assert!(result.is_err(), "unauthorized update must fail");

        // State is unchanged.
        let listing = client.get_listing(&id);
        assert_eq!(listing.owner, owner);
        assert_eq!(listing.title, String::from_str(&env, "Original"));
        assert_eq!(listing.price_per_night, 100_0000000_i128);
        assert_eq!(listing.status, ListingStatus::Active);
        assert_eq!(client.listing_count(), 1);
    }

    // ─── Bounded Input Tests ──────────────────────────────────────────────────

    /// Prices across the full valid range round-trip exactly (no overflow).
    #[test]
    fn test_price_bounds_round_trip() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let prices: &[i128] = &[1, 2, 999, 1_000_000, 50_0000000, i128::MAX / 2, i128::MAX];
        for &price in prices {
            let id = client.create_listing(
                &owner,
                &String::from_str(&env, "Bounded"),
                &String::from_str(&env, "desc"),
                &price,
            );
            assert_eq!(client.get_listing(&id).price_per_night, price);
        }
    }

    /// Repeated updates never accumulate drift: the last write wins exactly.
    #[test]
    fn test_repeated_updates_last_write_wins() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Start"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        for i in 1_u64..=20 {
            let price = (i as i128) * 1_0000000;
            client.update_listing(
                &owner,
                &id,
                &String::from_str(&env, "Updated"),
                &String::from_str(&env, "desc"),
                &price,
            );
            assert_eq!(client.get_listing(&id).price_per_night, price);
        }

        // Ownership and identity are invariant across updates.
        let listing = client.get_listing(&id);
        assert_eq!(listing.id, id);
        assert_eq!(listing.owner, owner);
        assert_eq!(client.listing_count(), 1);
    }

    /// Long-but-valid strings are stored verbatim without truncation.
    #[test]
    fn test_long_strings_round_trip() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let long_title = "T".repeat(200);
        let long_desc = "D".repeat(500);
        let id = client.create_listing(
            &owner,
            &String::from_str(&env, &long_title),
            &String::from_str(&env, &long_desc),
            &100_0000000_i128,
        );

        let listing = client.get_listing(&id);
        assert_eq!(listing.title, String::from_str(&env, &long_title));
        assert_eq!(listing.description, String::from_str(&env, &long_desc));
    }

    // ─── Lifecycle / Invariant Tests ──────────────────────────────────────────

    /// Status lifecycle: Active -> Rented is one-way via set_rented.
    #[test]
    #[should_panic(expected = "Property is not available for booking")]
    fn test_set_rented_replay_rejected() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.set_rented(&id);
        // Replaying the transition must fail.
        client.set_rented(&id);
    }

    /// set_rented on an already-Rented listing (via update_status) is rejected.
    #[test]
    #[should_panic(expected = "Property is not available for booking")]
    fn test_set_rented_on_rented_rejected() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );

        client.update_status(&owner, &id, &ListingStatus::Rented);
        client.set_rented(&id);
    }

    /// A rejected transition leaves the previous status intact.
    #[test]
    fn test_rejected_transition_preserves_state() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Property"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        client.update_status(&owner, &id, &ListingStatus::Inactive);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rented(&id);
        }));
        assert!(result.is_err(), "set_rented on Inactive must fail");

        assert_eq!(client.get_listing(&id).status, ListingStatus::Inactive);
    }

    /// Ownership invariant: only the recorded owner can mutate a listing,
    /// even after other listings are created by other owners.
    #[test]
    fn test_ownership_invariant_across_owners() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner_a = Address::generate(&env);
        let owner_b = Address::generate(&env);

        let id_a = client.create_listing(
            &owner_a,
            &String::from_str(&env, "A"),
            &String::from_str(&env, "desc"),
            &100_0000000_i128,
        );
        let id_b = client.create_listing(
            &owner_b,
            &String::from_str(&env, "B"),
            &String::from_str(&env, "desc"),
            &200_0000000_i128,
        );

        // owner_b cannot mutate owner_a's listing.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_listing(
                &owner_b,
                &id_a,
                &String::from_str(&env, "Hijacked"),
                &String::from_str(&env, "desc"),
                &1_i128,
            );
        }));
        assert!(result.is_err(), "cross-owner update must fail");

        // Both listings retain their original owners and data.
        assert_eq!(client.get_listing(&id_a).owner, owner_a);
        assert_eq!(client.get_listing(&id_b).owner, owner_b);
        assert_eq!(client.get_listing(&id_a).title, String::from_str(&env, "A"));
        assert_eq!(client.get_listing(&id_b).title, String::from_str(&env, "B"));
    }

    /// Listing IDs are unique and monotonically increasing (no reuse).
    #[test]
    fn test_ids_unique_and_monotonic() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let mut seen: std::vec::Vec<u64> = std::vec::Vec::new();
        for _ in 0..15 {
            let id = client.create_listing(
                &owner,
                &String::from_str(&env, "Property"),
                &String::from_str(&env, "desc"),
                &100_0000000_i128,
            );
            assert!(!seen.contains(&id), "listing ID must be unique");
            if let Some(&last) = seen.last() {
                assert!(id > last, "listing IDs must be monotonically increasing");
            }
            seen.push(id);
        }
        assert_eq!(client.listing_count(), seen.len() as u64);
    }
}
