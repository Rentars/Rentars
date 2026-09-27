//! Authorization and invariant tests for the booking contract (#624).
//!
//! These tests are intentionally self-contained against the current `lib.rs`
//! public surface (auth, replay, arithmetic bounds, state transitions).

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{BookingContract, BookingContractClient, BookingStatus};
use property_listing::{
    ListingStatus, PropertyListingContract, PropertyListingContractClient,
};

const CHECK_IN: u64 = 1_000;
const CHECK_OUT: u64 = 1_000 + 86_400;
const PRICE: i128 = 700_0000000;

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let listing_cid = env.register_contract(None, PropertyListingContract);
    let booking_cid = env.register_contract(None, BookingContract);
    let admin = Address::generate(&env);

    let booking = BookingContractClient::new(&env, &booking_cid);
    booking.initialize(&admin, &listing_cid);

    (env, booking_cid, listing_cid, admin)
}

fn create_active_property(env: &Env, listing_cid: &Address, owner: &Address) -> u64 {
    let listing = PropertyListingContractClient::new(env, listing_cid);
    listing.create_listing(
        owner,
        &String::from_str(env, "Cabin"),
        &String::from_str(env, "Nice place"),
        &100_0000000_i128,
    )
}

#[test]
fn version_is_reported() {
    let (env, booking_cid, _, _) = setup();
    let client = BookingContractClient::new(&env, &booking_cid);
    assert_eq!(client.version(), 100);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn initialize_replay_rejected() {
    let (env, booking_cid, listing_cid, _) = setup();
    let client = BookingContractClient::new(&env, &booking_cid);
    let other = Address::generate(&env);
    client.initialize(&other, &listing_cid);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn cancel_by_non_tenant_rejected() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let attacker = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.cancel_booking(&attacker, &id);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn update_status_by_non_admin_rejected() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let attacker = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.update_status(&attacker, &id, &BookingStatus::Confirmed);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn set_escrow_by_non_admin_rejected() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let attacker = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.set_escrow_id(&attacker, &id, &String::from_str(&env, "escrow-1"));
}

#[test]
#[should_panic(expected = "escrow_id already set")]
fn set_escrow_replay_rejected() {
    let (env, booking_cid, listing_cid, admin) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.set_escrow_id(&admin, &id, &String::from_str(&env, "escrow-1"));
    booking.set_escrow_id(&admin, &id, &String::from_str(&env, "escrow-2"));
}

#[test]
#[should_panic(expected = "Invalid status transition")]
fn out_of_order_pending_to_completed_rejected() {
    let (env, booking_cid, listing_cid, admin) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.update_status(&admin, &id, &BookingStatus::Completed);
}

#[test]
fn valid_state_machine_preserves_balance_fields() {
    let (env, booking_cid, listing_cid, admin) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let check_out = CHECK_IN + 3 * 86_400;

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &check_out, &PRICE);

    let before = booking.get_booking(&id);
    assert_eq!(before.total_price, PRICE);
    assert_eq!(before.status, BookingStatus::Pending);

    booking.update_status(&admin, &id, &BookingStatus::Confirmed);
    let mid = booking.get_booking(&id);
    assert_eq!(mid.total_price, PRICE);
    assert_eq!(mid.status, BookingStatus::Confirmed);
    assert_eq!(mid.tenant, tenant);
    assert_eq!(mid.property_id, property_id);

    booking.update_status(&admin, &id, &BookingStatus::Completed);
    let done = booking.get_booking(&id);
    assert_eq!(done.total_price, PRICE);
    assert_eq!(done.status, BookingStatus::Completed);
    assert_eq!(booking.booking_count(), 1);
}

#[test]
#[should_panic(expected = "total_price exceeds maximum bound")]
fn total_price_bound_enforced() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let too_high = 1_000_000_0000000_i128 + 1;

    let property_id = create_active_property(&env, &listing_cid, &owner);
    booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &too_high);
}

#[test]
#[should_panic(expected = "stay duration exceeds maximum")]
fn stay_duration_bound_enforced() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let year = 365 * 24 * 60 * 60_u64;
    let check_out = CHECK_IN + year + 1;

    let property_id = create_active_property(&env, &listing_cid, &owner);
    booking.create_booking(&tenant, &property_id, &CHECK_IN, &check_out, &PRICE);
}

#[test]
#[should_panic(expected = "Booking dates overlap with an existing booking")]
fn overlapping_dates_rejected() {
    let (env, booking_cid, listing_cid, _) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let listing = PropertyListingContractClient::new(&env, &listing_cid);
    let owner = Address::generate(&env);
    let tenant_a = Address::generate(&env);
    let tenant_b = Address::generate(&env);
    let check_out_a = CHECK_IN + 7 * 86_400;
    let check_in_b = CHECK_IN + 2 * 86_400;
    let check_out_b = CHECK_IN + 9 * 86_400;

    let property_id = create_active_property(&env, &listing_cid, &owner);
    booking.create_booking(&tenant_a, &property_id, &CHECK_IN, &check_out_a, &PRICE);

    // Property is now Rented — flip back to Active to isolate overlap check.
    listing.update_status(&owner, &property_id, &ListingStatus::Active);

    booking.create_booking(&tenant_b, &property_id, &check_in_b, &check_out_b, &PRICE);
}

#[test]
#[should_panic(expected = "Cannot cancel a completed booking")]
fn cancel_completed_rejected() {
    let (env, booking_cid, listing_cid, admin) = setup();
    let booking = BookingContractClient::new(&env, &booking_cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let property_id = create_active_property(&env, &listing_cid, &owner);
    let id = booking.create_booking(&tenant, &property_id, &CHECK_IN, &CHECK_OUT, &PRICE);
    booking.update_status(&admin, &id, &BookingStatus::Confirmed);
    booking.update_status(&admin, &id, &BookingStatus::Completed);
    booking.cancel_booking(&tenant, &id);
}
