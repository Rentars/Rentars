//! Authorization and invariant tests for the property-listing contract (#624).

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{
    ListingStatus, PropertyListingContract, PropertyListingContractClient,
};

fn make_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register_contract(None, PropertyListingContract);
    (env, cid)
}

#[test]
fn version_is_reported() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    assert_eq!(client.version(), 100);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn initialize_replay_rejected() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let booking = Address::generate(&env);
    client.initialize(&admin, &booking);
    client.initialize(&admin, &booking);
}

#[test]
fn initialized_set_rented_requires_booking_auth_context() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let admin = Address::generate(&env);
    let booking = Address::generate(&env);
    let owner = Address::generate(&env);

    client.initialize(&admin, &booking);

    let id = client.create_listing(
        &owner,
        &String::from_str(&env, "Loft"),
        &String::from_str(&env, "desc"),
        &50_0000000_i128,
    );

    // With mock_all_auths, booking.require_auth() succeeds and status flips.
    client.set_rented(&id);
    assert_eq!(client.get_listing(&id).status, ListingStatus::Rented);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn update_listing_unauthorized() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    let id = client.create_listing(
        &owner,
        &String::from_str(&env, "Loft"),
        &String::from_str(&env, "desc"),
        &50_0000000_i128,
    );

    client.update_listing(
        &attacker,
        &id,
        &String::from_str(&env, "Hacked"),
        &String::from_str(&env, "x"),
        &1_i128,
    );
}

#[test]
#[should_panic(expected = "price_per_night exceeds maximum bound")]
fn price_bound_enforced() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let owner = Address::generate(&env);

    client.create_listing(
        &owner,
        &String::from_str(&env, "Palace"),
        &String::from_str(&env, "desc"),
        &(100_000_0000000_i128 + 1),
    );
}

#[test]
#[should_panic(expected = "title exceeds maximum length")]
fn title_length_bound_enforced() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let owner = Address::generate(&env);

    // 201 ASCII 'A' characters — exceeds MAX_TITLE_LEN (200).
    let long_title = String::from_str(
        &env,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    assert_eq!(long_title.len(), 201);

    client.create_listing(
        &owner,
        &long_title,
        &String::from_str(&env, "desc"),
        &50_0000000_i128,
    );
}

#[test]
fn listing_count_and_price_remain_consistent() {
    let (env, cid) = make_env();
    let client = PropertyListingContractClient::new(&env, &cid);
    let owner = Address::generate(&env);

    let id1 = client.create_listing(
        &owner,
        &String::from_str(&env, "A"),
        &String::from_str(&env, "d"),
        &10_0000000_i128,
    );
    let id2 = client.create_listing(
        &owner,
        &String::from_str(&env, "B"),
        &String::from_str(&env, "d"),
        &20_0000000_i128,
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(client.listing_count(), 2);
    assert_eq!(client.get_listing(&id1).price_per_night, 10_0000000_i128);
    assert_eq!(client.get_listing(&id2).price_per_night, 20_0000000_i128);

    client.update_listing(
        &owner,
        &id1,
        &String::from_str(&env, "A2"),
        &String::from_str(&env, "d2"),
        &15_0000000_i128,
    );
    assert_eq!(client.get_listing(&id1).price_per_night, 15_0000000_i128);
    assert_eq!(client.get_listing(&id1).owner, owner);
}
