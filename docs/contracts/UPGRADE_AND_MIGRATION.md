# Soroban Contract Upgrade & Migration Strategy (#625)

Soroban WASM deployments are **immutable**. Upgrades are performed by
deploying a successor contract and repointing application configuration —
not by in-place rollback of bytecode.

## Goals

1. Preserve or explicitly reconcile existing listings, bookings, escrow IDs,
   and payment references.
2. Let the application identify old vs new contract versions at runtime.
3. Exercise cutover and rollback on testnet before mainnet.

## Immutable vs migratable state

| Category | Examples | Strategy |
|----------|----------|----------|
| **Immutable on-chain records** | Booking IDs, listing IDs, escrow string refs, historical reviews | Leave in place on the old contract; dual-read until retention window ends |
| **Migratable indexes** | Admin address, property-listing ↔ booking wiring, token address | Re-`initialize` successor; optionally copy via admin migration txs |
| **Off-chain references** | DB rows with `contract_id`, `on_chain_booking_id`, payment refs | Dual-write during cutover; never rewrite historical payment hashes |
| **ABI / client bindings** | `*_abi.json`, backend `bookingContract.ts` | Versioned side-by-side; release gate compares hashes |

## Versioning

Every Rentars contract exposes:

```rust
pub fn version(env: Env) -> u32; // major * 100 + minor, currently 100 (v1.0)
```

App config stores both addresses:

```ts
// apps/web/src/lib/contracts/versions.ts
NEXT_PUBLIC_BOOKING_CONTRACT_ID_V1=C…
NEXT_PUBLIC_BOOKING_CONTRACT_ID_V2=C…   // optional during dual-read
NEXT_PUBLIC_CONTRACT_VERSION_MIN=100
```

`resolveContract(kind)` returns `{ address, version, generation: 'current' | 'legacy' }`.

## Upgrade authority

| Role | Responsibility |
|------|----------------|
| **Contract admin** (on-chain) | One-time `initialize` of successor; cannot mutate peer contract bytecode |
| **Release owner** (ops) | Deploy WASM, update env vars / secrets, flip feature flag |
| **App dual-read window** | Read legacy for historical IDs; write only to current |

There is no on-chain upgrade key that silently swaps storage. Authority is
operational: who can change `BOOKING_CONTRACT_ID` in deployment secrets.

## Dual-read / dual-write period

```
Day 0   Deploy successor on testnet; run fixture migration script
Day 1–N Dual-read: lookups by ID try current then legacy
        Dual-write OFF for bookings (new bookings → current only)
Day N+1 Cutover flag: FRONTEND_CONTRACT_GENERATION=current
Day N+7 Stop dual-read if metrics show zero legacy misses
```

Rollback within the window: flip env vars back to the previous address and
redeploy the prior app image. Booking/payment references remain valid because
IDs were never rewritten.

## Testnet procedure

1. Deploy property-listing + booking + review successors (`make deploy-testnet`).
2. Call `initialize` with the same admin and wire booking ↔ listing.
3. Run `scripts/migrate-contract-fixtures.ts` against representative fixtures
   (sample listing IDs, open bookings, escrow refs).
4. Verify:
   - `version()` on each successor returns expected constant
   - Fixture IDs readable via dual-read adapter
   - Balances / `total_price` match fixture snapshots
5. Record ABI SHA-256 in `docs/releases/manifest-*.json`.

## Release gate (ABI + data compatibility)

`scripts/check-contract-compat.ts` must exit 0 before merge to `main`:

- ABI JSON files present and hashed
- `CONTRACT_VERSION` in Rust sources matches `versions.ts` minimum
- Manifest `contracts.abi_sha256` matches current files when cutting a release

CI job: `contract-compat` (see `.github/workflows/contract-compat.yml`).

## Cutover checklist

- [ ] Successor deployed on testnet; `version()` verified
- [ ] Fixture migration verified (IDs + balances)
- [ ] Dual-read adapter enabled in staging
- [ ] Cutover flag flipped; smoke booking + escrow path
- [ ] Rollback drill: restore previous contract IDs, confirm reads
- [ ] Manifest updated with ABI hashes and contract addresses
- [ ] Mainnet change window scheduled with on-call

## Related docs

- `docs/releases/rollback.md` — app/image rollback
- `apps/contracts/AUTH_INVARIANTS.md` — auth matrix that must hold across versions
- `apps/web/src/lib/contracts/versions.ts` — runtime version resolution
