# Contract Authorization & Invariant Matrix (#624)

Maps every public entry point to its caller requirement, arithmetic bounds,
and replay / state-transition guards. Use this as the security checklist
before mainnet deployment.

## property-listing

| Entry point | Auth | Bounds / invariants | Replay / ordering |
|-------------|------|---------------------|-------------------|
| `initialize(admin, booking_contract)` | `admin.require_auth()` | once-only | panics `"Already initialized"` |
| `create_listing(owner, …)` | `owner.require_auth()` | title 1..=200; price `> 0` and `<= MAX_PRICE_PER_NIGHT`; ID via `checked_add` | N/A |
| `update_listing(caller, id, …)` | `caller.require_auth()` + `caller == owner` | same price/title bounds | N/A |
| `update_status(caller, id, status)` | `caller.require_auth()` + `caller == owner` | listing must exist | N/A |
| `set_rented(id)` | when initialized: `booking_contract.require_auth()` | listing must be `Active` | cannot re-rent non-Active |
| `get_listing` / `listing_count` / `version` | none (read) | — | — |

## booking

| Entry point | Auth | Bounds / invariants | Replay / ordering |
|-------------|------|---------------------|-------------------|
| `initialize(admin, listing_cid)` | `admin.require_auth()` | once-only | panics `"Already initialized"` |
| `create_booking(tenant, …)` | `tenant.require_auth()` | `check_in < check_out`; stay `<= 365d`; `0 < total_price <= MAX`; no date overlap; property `Active`; ID via `checked_add` | overlap rejects concurrent windows |
| `cancel_booking(caller, id)` | `caller.require_auth()` + tenant | not Cancelled/Completed | terminal cancel rejected |
| `update_status(caller, id, status)` | `caller.require_auth()` + admin | state machine only | out-of-order panics `"Invalid status transition"` |
| `set_escrow_id(caller, id, escrow)` | `caller.require_auth()` + admin | non-empty; not terminal; not already set | replay of second set rejected |
| queries / `version` | none (read) | — | — |

### Booking state machine

```
Pending  → Confirmed → Completed
   │            │
   └→ Cancelled ←┘
```

## review-contract

| Entry point | Auth | Bounds / invariants | Replay / ordering |
|-------------|------|---------------------|-------------------|
| `submit_review(reviewer, booking_id, …)` | `reviewer.require_auth()` | rating 1..=5; DID length 1..=128; comment `<= 500`; no self-review; ID via `checked_add` | `(booking_id, reviewer_did)` dedup key |
| queries / `version` | none (read) | reputation = floor(avg) | — |

## rental-contract (legacy monolithic)

| Entry point | Auth | Bounds / invariants | Replay / ordering |
|-------------|------|---------------------|-------------------|
| `list_property` | `owner.require_auth()` | price bounds; checked ID | — |
| `book_property` | `tenant.require_auth()` | stay bounds; `checked_mul` for total | property must be available |
| `update_status` | `caller.require_auth()` | state machine | out-of-order panics |
| `set_escrow_id` | `caller.require_auth()` + tenant | not terminal | — |
| `confirm_rental` | `caller.require_auth()` | must be Confirmed | replay on Completed panics |
| `version` | none | — | — |

## Test coverage

Invariant suites live next to each contract:

- `booking/src/invariants.rs`
- `property-listing/src/invariants.rs`
- `review-contract/src/invariants.rs`
- `rental-contract/src/test.rs`

Run:

```bash
cd apps/contracts
cargo test -p booking --lib
cargo test -p property-listing --lib invariants
cargo test -p review-contract --lib
cargo test -p rental-contract --lib
```
