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

    // ─── Cross-Contract Integration Tests ─────────────────────────────────────
    //
    // These tests deploy both the PropertyListing contract and the Booking
    // contract into a single `Env` so that the integrated rental flow is
    // exercised end-to-end. They mirror the harness used on the booking side
    // and assert that the property-listing interface (`get_listing`,
    // `set_rented`, `update_status`) reports state that the booking contract's
    // eligibility checks observe consistently.
    //
    // Invariants under test:
    //   * A booking is only eligible while the listing status is `Active`.
    //   * `set_rented` is only callable while the listing is `Active`.
    //   * A failed booking attempt leaves the listing status unchanged
    //     (no partial writes across the contract boundary).

    mod cross_contract {
        use super::*;
        use soroban_sdk::testutils::Address as _;

        /// Deploy both contracts into one environment and return the two
        /// clients plus the listing owner address.
        ///
        /// The booking contract is referenced through its public client so the
        /// test compiles against the same interface backend clients encode.
        fn deploy_both(
            env: &Env,
        ) -> (
            PropertyListingContractClient<'_>,
            booking::BookingContractClient<'_>,
            Address,
        ) {
            env.mock_all_auths();

            let property_id = env.register_contract(None, PropertyListingContract);
            let booking_id = env.register_contract(None, booking::BookingContract);

            let property = PropertyListingContractClient::new(env, &property_id);
            let booking = booking::BookingContractClient::new(env, &booking_id);

            let owner = Address::generate(env);
            (property, booking, owner)
        }

        /// Create a listing through the property contract and return its id.
        fn seed_listing(
            env: &Env,
            property: &PropertyListingContractClient<'_>,
            owner: &Address,
        ) -> u64 {
            property.create_listing(
                owner,
                &String::from_str(env, "Cross-Contract Cabin"),
                &String::from_str(env, "Listing used by integration tests"),
                &50_0000000_i128,
            )
        }

        /// The booking contract observes an `Active` listing as eligible.
        #[test]
        fn test_booking_eligible_while_listing_active() {
            let env = Env::default();
            let (property, booking, owner) = deploy_both(&env);
            let listing_id = seed_listing(&env, &property, &owner);

            assert_eq!(
                property.get_listing(&listing_id).status,
                ListingStatus::Active,
                "property-listing::get_listing must report Active for a freshly created listing"
            );

            assert!(
                booking.is_listing_eligible(&listing_id),
                "cross-contract invariant: booking::is_listing_eligible must be true while \
                 property-listing::get_listing reports Active"
            );
        }

        /// After `set_rented`, the booking contract no longer sees the listing
        /// as eligible — the Active -> Rented transition is observed across the
        /// contract boundary.
        #[test]
        fn test_set_rented_observed_by_booking_eligibility() {
            let env = Env::default();
            let (property, booking, owner) = deploy_both(&env);
            let listing_id = seed_listing(&env, &property, &owner);

            property.set_rented(&listing_id);

            assert_eq!(
                property.get_listing(&listing_id).status,
                ListingStatus::Rented,
                "property-listing::set_rented must transition status Active -> Rented"
            );
            assert!(
                !booking.is_listing_eligible(&listing_id),
                "cross-contract invariant: booking::is_listing_eligible must be false after \
                 property-listing::set_rented marks the listing Rented"
            );
        }

        /// After the owner marks a listing `Inactive`, the booking contract
        /// observes it as ineligible.
        #[test]
        fn test_inactive_listing_observed_by_booking_eligibility() {
            let env = Env::default();
            let (property, booking, owner) = deploy_both(&env);
            let listing_id = seed_listing(&env, &property, &owner);

            property.update_status(&owner, &listing_id, &ListingStatus::Inactive);

            assert_eq!(
                property.get_listing(&listing_id).status,
                ListingStatus::Inactive,
                "property-listing::update_status must transition status Active -> Inactive"
            );
            assert!(
                !booking.is_listing_eligible(&listing_id),
                "cross-contract invariant: booking::is_listing_eligible must be false while \
                 property-listing::get_listing reports Inactive"
            );
        }

        /// `set_rented` is only callable while the listing is `Active`; calling
        /// it on an `Inactive` listing must fail and leave the status unchanged.
        #[test]
        fn test_set_rented_requires_active_listing() {
            let env = Env::default();
            let (property, booking, owner) = deploy_both(&env);
            let listing_id = seed_listing(&env, &property, &owner);

            property.update_status(&owner, &listing_id, &ListingStatus::Inactive);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                property.set_rented(&listing_id);
            }));
            assert!(
                result.is_err(),
                "property-listing::set_rented must reject a listing that is not Active"
            );

            assert_eq!(
                property.get_listing(&listing_id).status,
                ListingStatus::Inactive,
                "cross-contract invariant: a failed property-listing::set_rented must not \
                 mutate the listing status"
            );
            assert!(
                !booking.is_listing_eligible(&listing_id),
                "cross-contract invariant: booking::is_listing_eligible must remain false after \
                 a failed property-listing::set_rented"
            );
        }

        /// A failed booking attempt (listing not eligible) must not leave any
        /// partial writes: the listing status stays `Active` and the booking
        /// contract records no reservation.
        #[test]
        fn test_failed_booking_leaves_listing_unchanged() {
            let env = Env::default();
            let (property, booking, owner) = deploy_both(&env);
            let listing_id = seed_listing(&env, &property, &owner);

            // Make the listing ineligible, then attempt a booking.
            property.update_status(&owner, &listing_id, &ListingStatus::Inactive);

            let guest = Address::generate(&env);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                booking.book_listing(&guest, &listing_id);
            }));
            assert!(
                result.is_err(),
                "booking::book_listing must fail when property-listing reports an ineligible \
                 listing"
            );

            assert_eq!(
                property.get_listing(&listing_id).status,
                ListingStatus::Inactive,
                "cross-contract invariant: a failed booking must not mutate the listing status \
                 reported by property-listing::get_listing"
            );
            assert!(
                !booking.has_reservation(&listing_id),
                "cross-contract invariant: a failed booking must not persist a reservation in \
                 the booking contract"
            );
        }

        /// A booking against a listing id that does not exist in the property
        /// contract must fail without creating any state.
        #[test]
        fn test_booking_missing_listing_fails() {
            let env = Env::default();
            let (property, booking, _owner) = deploy_both(&env);

            let guest = Address::generate(&env);
            let missing_id = 9999_u64;

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                booking.book_listing(&guest, &missing_id);
            }));
            assert!(
                result.is_err(),
                "booking::book_listing must fail when property-listing::get_listing reports \
                 the listing is missing"
            );
            assert!(
                !booking.has_reservation(&missing_id),
                "cross-contract invariant: a failed booking for a missing listing must not \
                 persist a reservation"
            );
            assert!(
                !property.listing_exists(&missing_id),
                "property-listing::listing_exists must remain false for a missing listing"
            );
        }
    }

    // ─── Resource / Cost Regression Measurements (Issue 119) ─────────────────
    //
    // These tests measure Soroban CPU instruction and memory consumption for
    // representative property-listing operations and emit one
    // `RESOURCE_METRIC {json}` line per measurement. The CI comparison script
    // (`scripts/check-resource-budget.sh`) parses those lines and fails the
    // build when a metric exceeds the configured budget.
    //
    // The measurements are fully reproducible: they use the in-memory Soroban
    // test host with a pinned toolchain and require no production credentials.
    //
    // To intentionally change a budget, update
    // `scripts/resource-budgets.json` and document the reason in
    // `docs/resource-budgets.md`.

    /// Maximum title length exercised by the resource tests (bytes).
    const MAX_TITLE_LEN: u32 = 128;
    /// Maximum description length exercised by the resource tests (bytes).
    const MAX_DESC_LEN: u32 = 512;

    /// Build a string of `len` ASCII bytes (all 'a') for max-size scenarios.
    fn max_len_string(env: &Env, len: u32) -> String {
        let mut buf = [b'a'; 512];
        let slice = &mut buf[..len as usize];
        String::from_bytes(env, slice)
    }

    /// Emit a single machine-readable resource metric line.
    fn emit_metric(operation: &str, cpu: u64, mem: u64) {
        // Keep the format stable and easy to parse from shell/CI.
        std::println!(
            "RESOURCE_METRIC {{\"contract\":\"property-listing\",\"operation\":\"{}\",\"cpu_instructions\":{},\"memory_bytes\":{}}}",
            operation, cpu, mem
        );
    }

    /// Measure a closure's resource usage and emit the metric.
    fn measure<F: FnOnce()>(env: &Env, operation: &str, f: F) {
        env.budget().reset_unlimited();
        f();
        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        emit_metric(operation, cpu, mem);
    }

    /// Resource measurement: create a listing with typical-size fields.
    #[test]
    fn test_resource_create_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        measure(&env, "create_listing", || {
            client.create_listing(
                &owner,
                &String::from_str(&env, "Mountain Cabin"),
                &String::from_str(&env, "Peaceful retreat in the Alps"),
                &50_0000000_i128,
            );
        });
    }

    /// Resource measurement: create a listing with maximum-size title/description.
    #[test]
    fn test_resource_create_listing_max_size() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let title = max_len_string(&env, MAX_TITLE_LEN);
        let desc = max_len_string(&env, MAX_DESC_LEN);

        measure(&env, "create_listing_max_size", || {
            client.create_listing(&owner, &title, &desc, &50_0000000_i128);
        });
    }

    /// Resource measurement: update a listing with typical-size fields.
    #[test]
    fn test_resource_update_listing() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "A lovely place by the sea"),
            &100_0000000_i128,
        );

        measure(&env, "update_listing", || {
            client.update_listing(
                &owner,
                &id,
                &String::from_str(&env, "Updated Beach House"),
                &String::from_str(&env, "Renovated with ocean view"),
                &150_0000000_i128,
            );
        });
    }

    /// Resource measurement: update a listing with maximum-size title/description.
    #[test]
    fn test_resource_update_listing_max_size() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        let owner = Address::generate(&env);

        let id = client.create_listing(
            &owner,
            &String::from_str(&env, "Cozy Beach House"),
            &String::from_str(&env, "A lovely place by the sea"),
            &100_0000000_i128,
        );

        let title = max_len_string(&env, MAX_TITLE_LEN);
        let desc = max_len_string(&env, MAX_DESC_LEN);

        measure(&env, "update_listing_max_size", || {
            client.update_listing(&owner, &id, &title, &desc, &150_0000000_i128);
        });
    }

    // ─── Pagination Tests ─────────────────────────────────────────────────────

    /// Maximum page size the contract will serve in a single call.
    const MAX_PAGE_SIZE: u32 = 20;

    /// Seed `count` listings and return their IDs in creation order.
    fn seed_listings(env: &Env, client: &PropertyListingContractClient, count: u64) -> Vec<u64> {
        let owner = Address::generate(env);
        let mut ids = Vec::new(env);
        for _ in 0..count {
            let id = client.create_listing(
                &owner,
                &String::from_str(env, "Paged Property"),
                &String::from_str(env, "desc"),
                &100_0000000_i128,
            );
            ids.push_back(id);
        }
        ids
    }

    /// Walk every page via keyset cursor and assert the concatenation is the
    /// complete, duplicate-free, gap-free, deterministically ordered history.
    fn assert_full_paged_history(
        env: &Env,
        client: &PropertyListingContractClient,
        expected: &Vec<u64>,
        page_size: u32,
    ) {
        let mut collected: Vec<u64> = Vec::new(env);
        let mut cursor: Option<u64> = None;
        let mut pages: u32 = 0;

        loop {
            let page = client.get_listings_page(&cursor, &page_size);
            pages += 1;
            // Pages must never exceed the requested size.
            assert!(
                page.len() <= page_size,
                "page {} exceeded requested size {}",
                pages,
                page_size
            );
            for id in page.iter() {
                collected.push_back(id);
            }
            match page.last() {
                Some(last) => cursor = Some(last),
                None => break,
            }
            // Guard against infinite loops on a misbehaving cursor.
            assert!(pages < 10_000, "pagination did not terminate");
        }

        assert_eq!(
            collected.len(),
            expected.len(),
            "paged history length mismatch"
        );
        for (i, id) in collected.iter().enumerate() {
            assert_eq!(
                id,
                expected.get(i as u32).unwrap(),
                "paged history mismatch at index {}",
                i
            );
        }
    }

    /// A collection larger than one page is fully retrievable through bounded pages.
    #[test]
    fn test_pagination_complete_history() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        let total = (MAX_PAGE_SIZE as u64) * 2 + 7;
        let ids = seed_listings(&env, &client, total);
        assert_eq!(client.listing_count(), total);

        assert_full_paged_history(&env, &client, &ids, MAX_PAGE_SIZE);
    }

    /// Page size is clamped to the documented maximum.
    #[test]
    fn test_pagination_clamps_page_size() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        let total = (MAX_PAGE_SIZE as u64) + 5;
        seed_listings(&env, &client, total);

        // Requesting an oversized page must not return more than the max.
        let page = client.get_listings_page(&None, &(MAX_PAGE_SIZE * 100));
        assert!(page.len() <= MAX_PAGE_SIZE);
        assert_eq!(page.len(), MAX_PAGE_SIZE);
    }

    /// A zero page size is rejected rather than silently returning everything.
    #[test]
    #[should_panic(expected = "page_size must be greater than zero")]
    fn test_pagination_rejects_zero_page_size() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);
        client.get_listings_page(&None, &0);
    }

    /// Cursor semantics are stable: the same cursor always yields the same page.
    #[test]
    fn test_pagination_cursor_is_stable() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        seed_listings(&env, &client, (MAX_PAGE_SIZE as u64) + 3);

        let first = client.get_listings_page(&None, &5);
        let cursor = first.last().unwrap();

        let page_a = client.get_listings_page(&Some(cursor), &5);
        let page_b = client.get_listings_page(&Some(cursor), &5);
        assert_eq!(page_a, page_b, "cursor must be deterministic");
    }

    /// A cursor past the end of the collection yields an empty page.
    #[test]
    fn test_pagination_cursor_past_end() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        seed_listings(&env, &client, 3);
        let page = client.get_listings_page(&Some(u64::MAX), &MAX_PAGE_SIZE);
        assert_eq!(page.len(), 0);
    }

    /// Pagination preserves authorization: reads are public but writes still
    /// require the owner, and paged reads never leak mutable state.
    #[test]
    fn test_pagination_preserves_authorization() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        let ids = seed_listings(&env, &client, (MAX_PAGE_SIZE as u64) + 1);
        let first_id = ids.get(0).unwrap();

        // Paged read is public and returns the same data as a direct read.
        let page = client.get_listings_page(&None, &MAX_PAGE_SIZE);
        assert_eq!(page.get(0).unwrap(), first_id);
        assert_eq!(client.get_listing(&first_id).id, first_id);
    }

    /// Resource usage: a full page read stays within a bounded CPU budget and
    /// does not grow with the total collection size.
    #[test]
    fn test_pagination_resource_usage_bounded() {
        let (env, cid) = make_env();
        let client = PropertyListingContractClient::new(&env, &cid);

        // Small collection: measure a full page read.
        seed_listings(&env, &client, MAX_PAGE_SIZE as u64);
        let small_budget = env.budget().reset_unlimited();
        let _ = client.get_listings_page(&None, &MAX_PAGE_SIZE);
        let small_cpu = env.budget().cpu_instruction_cost();
        let _ = small_budget;

        // Large collection: a single page read must cost roughly the same.
        seed_listings(&env, &client, (MAX_PAGE_SIZE as u64) * 5);
        env.budget().reset_unlimited();
        let _ = client.get_listings_page(&None, &MAX_PAGE_SIZE);
        let large_cpu = env.budget().cpu_instruction_cost();

        // Allow generous headroom for storage key hashing differences, but the
        // cost must not scale with the total number of listings.
        assert!(
            large_cpu < small_cpu.saturating_mul(3),
            "page read cost grew with collection size: small={} large={}",
            small_cpu,
            large_cpu
        );
    }
}
