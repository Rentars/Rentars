# Soroban Contract Upgrade and Data Migration Strategy

## Overview

Soroban contracts are immutable once deployed. Upgrading a contract means deploying
a new contract and migrating or reconciling all existing on-chain state. This
document specifies the upgrade authority model, compatibility periods, data migration
procedures, cutover validation steps, and acknowledged rollback limitations for the
three Rentars contracts: `property-listing`, `booking`, and `review`.

---

## 1. Upgrade Authority

All three contracts designate an **admin address** at initialization. Contract upgrades
are coordinated off-chain. The authority model for an upgrade is:

| Step | Responsible party |
|------|------------------|
| Deploy successor contract | Admin keypair |
| Migrate data (off-chain scripts) | Admin keypair + RPC node |
| Flip routing in backend config | Platform engineering |
| Decommission old contract | Admin keypair (after compatibility period) |

The admin address should be a multi-signature account or controlled by a governance
mechanism to prevent unilateral upgrades.

---

## 2. Immutable vs. Migratable State

### `property-listing`

| Field | Immutable? | Migration notes |
|-------|-----------|-----------------|
| `id` (counter) | Yes | Successor seeds counter from current `listing_count` + 1 |
| `owner` | Migratable | Read from old contract; write to new contract |
| `title`, `description`, `price_per_night` | Migratable | Copied verbatim |
| `status` | Migratable | Copied; `Rented` listings remain locked |

### `booking`

| Field | Immutable? | Migration notes |
|-------|-----------|-----------------|
| `id` (counter) | Yes | Successor seeds from current `booking_count` + 1 |
| `property_owner`, `tenant` | Migratable | Copied verbatim |
| `check_in`, `check_out`, `total_price` | Migratable | Copied verbatim |
| `status` | Migratable | Terminal states (`Completed`, `Cancelled`) are archived read-only |
| `escrow_status` | Migratable | `Funded` bookings must be settled before cutover |
| `escrow_id` | Migratable | Copied verbatim |

**Pre-condition**: All `Funded` escrows must reach a terminal state (`Released` or
`Refunded`) before the old booking contract is decommissioned. If any remain funded
at cutover, a manual admin `resolve_dispute` or `cancel_booking` must be executed.

### `review`

| Field | Immutable? | Migration notes |
|-------|-----------|-----------------|
| `id` (counter) | Yes | Successor seeds from current `review_count` + 1 |
| `reviewer`, `reviewee`, `rating`, `comment`, `timestamp` | Migratable | Copied verbatim |
| `HasReviewed` deduplication flags | Migratable | Re-populated from migrated reviews |

---

## 3. Data Migration Approach

### 3.1 Migration Script Requirements

Each migration script must:

1. **Read all records from the old contract** — iterate IDs from 1 to the
   `*_count()` value at the time migration begins. Record the count as the
   migration snapshot sequence number.
2. **Write to the successor contract** — call `create_*` or an admin-only bulk
   import function on the successor.
3. **Verify referential integrity** — after writing, re-read each record from
   the successor and assert field equality with the source.
4. **Be idempotent** — re-running the script must not create duplicate records.
   Use the source `id` as the idempotency key.

### 3.2 Representative Fixture Testnet Rehearsal

Before mainnet cutover, the migration script must be run against a Testnet fork
containing representative fixtures:

- At least 50 property listings across Active, Inactive, and Rented states.
- At least 100 bookings across all status values.
- At least 200 reviews with varied ratings and reviewer/reviewee combinations.

All fixture records must pass post-migration integrity checks before mainnet
migration is authorized.

---

## 4. Dual-Read / Adapter Period

During the compatibility period, the backend reads from **both** the old and the
new contract address. The adapter layer merges results by preferring the new
contract for records whose IDs fall within the migrated range, and falls back to
the old contract for any records not yet migrated.

```
backend config:
  property_listing_contract_id: <new>
  property_listing_contract_id_legacy: <old>   # present only during compat window
```

The backend's `PropertyListingClient` and `BookingClient` accept an optional
`legacy_contract_id` parameter. When present, read-only queries check the new
contract first; if the record is missing (i.e., migration not yet reached that ID),
the client retries against the legacy address.

**Compatibility period**: 14 days after the first successful mainnet migration run,
or until all IDs are confirmed migrated, whichever is later.

---

## 5. Cutover Validation

Before decommissioning the old contract, the following checks must all pass:

1. **Record count parity** — `old.listing_count() == new.listing_count()`.
2. **Spot-check 10% of IDs** — random sample; all fields must match exactly.
3. **No open funded escrows** — `booking.escrow_status != Funded` for all active
   bookings in the old contract.
4. **Cross-reference integrity** — every booking's `property_id` exists in the
   new `property-listing` contract.
5. **Deduplication flag consistency** — for every review in the new contract,
   `HasReviewed(reviewer, reviewee)` is set in instance storage.
6. **ABI compatibility check** — the successor contract's ABI is tested against
   the current backend client (TypeScript) before going live. The
   `scripts/check-abi-migration-changelog.sh` script must exit 0.

---

## 6. Rollback Limitations

Soroban contracts are immutable and there is no in-place rollback. If the successor
contract is found defective after cutover:

| Scenario | Recovery path |
|----------|--------------|
| Bug found before any new writes | Revert backend config to old contract; discard successor |
| Bug found after new writes | Deploy a second successor from the old contract's snapshot plus a diff of new-contract writes |
| Funded escrows on defective contract | Admin resolves all disputes via `resolve_dispute` before abandoning the contract |
| Data loss in new contract | Restore from the old contract (still on-chain until TTL expiry) via re-migration |

**No rollback is possible** once the old contract's ledger entries have expired
(TTL exhausted). The compatibility period must therefore exceed the TTL_EXTEND_TO
value of the old contract by a safe margin.

---

## 7. Release Review Requirements

Every release involving a contract upgrade must include:

- [ ] Updated ABI JSON files (`property_listing_abi.json`, `booking_abi.json`, `review_abi.json`).
- [ ] CHANGELOG entry with old and new contract addresses.
- [ ] Migration script reviewed and approved by a second engineer.
- [ ] Testnet rehearsal results attached as a CI artifact.
- [ ] ABI compatibility CI check passing (`check-abi-migration-changelog.sh`).
- [ ] Compatibility period start date recorded.
