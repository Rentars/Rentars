//! Authorization and invariant tests for the review contract (#624).

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{ReviewContract, ReviewContractClient};

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register_contract(None, ReviewContract);
    (env, cid)
}

#[test]
fn version_is_reported() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    assert_eq!(client.version(), 100);
}

#[test]
fn submit_review_requires_auth_and_persists() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    let reviewer = Address::generate(&env);

    let id = client.submit_review(
        &reviewer,
        &42_u64,
        &String::from_str(&env, "did:rentars:alice"),
        &String::from_str(&env, "did:rentars:bob"),
        &5_u32,
        &String::from_str(&env, "Great stay"),
    );

    assert_eq!(id, 1);
    let review = client.get_review(&id);
    assert_eq!(review.rating, 5);
    assert_eq!(review.booking_id, 42);
    assert_eq!(client.get_review_count(), 1);
    assert_eq!(
        client.get_reputation(&String::from_str(&env, "did:rentars:bob")),
        5
    );
}

#[test]
#[should_panic]
fn duplicate_review_replay_rejected() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    let reviewer = Address::generate(&env);

    let args = (
        &reviewer,
        &7_u64,
        String::from_str(&env, "did:rentars:alice"),
        String::from_str(&env, "did:rentars:bob"),
        4_u32,
        String::from_str(&env, "ok"),
    );

    client.submit_review(
        args.0,
        args.1,
        &args.2,
        &args.3,
        &args.4,
        &args.5,
    );
    client.submit_review(
        args.0,
        args.1,
        &args.2,
        &args.3,
        &args.4,
        &args.5,
    );
}

#[test]
#[should_panic]
fn self_review_rejected() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    let reviewer = Address::generate(&env);
    let did = String::from_str(&env, "did:rentars:same");

    client.submit_review(
        &reviewer,
        &1_u64,
        &did,
        &did,
        &3_u32,
        &String::from_str(&env, "nope"),
    );
}

#[test]
#[should_panic]
fn invalid_rating_rejected() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    let reviewer = Address::generate(&env);

    client.submit_review(
        &reviewer,
        &1_u64,
        &String::from_str(&env, "did:rentars:a"),
        &String::from_str(&env, "did:rentars:b"),
        &0_u32,
        &String::from_str(&env, "bad"),
    );
}

#[test]
fn reputation_average_is_consistent() {
    let (env, cid) = setup();
    let client = ReviewContractClient::new(&env, &cid);
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let target = String::from_str(&env, "did:rentars:host");

    client.submit_review(
        &r1,
        &1_u64,
        &String::from_str(&env, "did:rentars:t1"),
        &target,
        &5_u32,
        &String::from_str(&env, "a"),
    );
    client.submit_review(
        &r2,
        &2_u64,
        &String::from_str(&env, "did:rentars:t2"),
        &target,
        &3_u32,
        &String::from_str(&env, "b"),
    );

    assert_eq!(client.get_reputation(&target), 4);
    assert_eq!(client.get_review_count(), 2);
    assert_eq!(client.get_reviews_for_user(&target).len(), 2);
}
