# Contract cutover & rollback drill (#625)

Companion runbook to `docs/contracts/UPGRADE_AND_MIGRATION.md`.

## Cutover (testnet)

```bash
# 1. Deploy successors (example)
cd apps/contracts
make deploy-testnet   # or project-specific deploy scripts

# 2. Initialize + wire
#    property-listing.initialize(admin, booking_cid)
#    booking.initialize(admin, listing_cid)

# 3. Migrate fixtures / verify
npx tsx scripts/migrate-contract-fixtures.ts --network testnet

# 4. Compatibility gate
npx tsx scripts/check-contract-compat.ts

# 5. Point staging at new IDs (dual-read)
export NEXT_PUBLIC_BOOKING_CONTRACT_ID=<new>
export NEXT_PUBLIC_BOOKING_CONTRACT_ID_LEGACY=<old>
export NEXT_PUBLIC_CONTRACT_GENERATION=current
```

## Rollback drill

1. Set `NEXT_PUBLIC_CONTRACT_GENERATION=legacy` (or swap current/legacy IDs).
2. Redeploy prior web/backend image from `docs/releases/manifest-*.json`.
3. Confirm historical booking IDs and escrow payment refs still resolve.
4. File drill notes in the incident tracker.

Success criteria: no lost booking or payment references; `version()` matches
the generation in use.
