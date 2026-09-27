//! Authorization and invariant tests for the monolithic rental contract (#624).

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{BookingStatus, RentarsContract, RentarsContractClient};

const CHECK_IN: u64 = 0;
const CHECK_OUT: u64 = 86_400;
const PRICE: i128 = 50_0000000;

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let cid = env.register_contract(None, RentarsContract);
    (env, cid)
}

#[test]
fn version_is_reported() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    assert_eq!(client.version(), 100);
}

#[test]
#[should_panic(expected = "price_per_night exceeds maximum bound")]
fn list_property_price_bound() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let too_high = 100_000_0000000_i128 + 1;
    client.list_property(&owner, &String::from_str(&env, "Villa"), &too_high);
}

#[test]
#[should_panic(expected = "Unauthorized: only the booking tenant can set the escrow ID")]
fn set_escrow_unauthorized() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);
    let attacker = Address::generate(&env);

    let pid = client.list_property(&owner, &String::from_str(&env, "Cabin"), &100_0000000_i128);
    let bid = client.book_property(&tenant, &pid, &CHECK_IN, &CHECK_OUT);
    client.set_escrow_id(&bid, &String::from_str(&env, "e1"), &attacker);
}

#[test]
#[should_panic(expected = "Invalid transition")]
fn out_of_order_status_rejected() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let pid = client.list_property(&owner, &String::from_str(&env, "Cabin"), &100_0000000_i128);
    let bid = client.book_property(&tenant, &pid, &CHECK_IN, &CHECK_OUT);
    client.update_status(&bid, &tenant, &BookingStatus::Completed);
}

#[test]
fn booking_amount_and_status_remain_consistent() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let pid = client.list_property(&owner, &String::from_str(&env, "Cabin"), &PRICE);
    let bid = client.book_property(&tenant, &pid, &CHECK_IN, &CHECK_OUT);

    let booking = client.get_booking(&bid);
    assert_eq!(booking.status, BookingStatus::Pending);
    assert_eq!(booking.tenant, tenant);
    assert_eq!(booking.total_amount, PRICE); // 1 night

    client.update_status(&bid, &owner, &BookingStatus::Confirmed);
    assert_eq!(client.get_booking(&bid).status, BookingStatus::Confirmed);
    assert_eq!(client.get_booking(&bid).total_amount, PRICE);

    client.confirm_rental(&bid, &owner);
    assert_eq!(client.get_booking(&bid).status, BookingStatus::Completed);
    assert_eq!(client.get_booking(&bid).total_amount, PRICE);
}

#[test]
#[should_panic(expected = "Cannot set escrow ID: booking is already Completed")]
fn escrow_on_terminal_rejected() {
    let (env, cid) = setup();
    let client = RentarsContractClient::new(&env, &cid);
    let owner = Address::generate(&env);
    let tenant = Address::generate(&env);

    let pid = client.list_property(&owner, &String::from_str(&env, "Cabin"), &100_0000000_i128);
    let bid = client.book_property(&tenant, &pid, &CHECK_IN, &CHECK_OUT);
    client.update_status(&bid, &owner, &BookingStatus::Confirmed);
    client.confirm_rental(&bid, &owner);
    client.set_escrow_id(&bid, &String::from_str(&env, "late"), &tenant);
}
