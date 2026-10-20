# Compatibility Requirements for ABI and Schema Changes

## Why this matters

Rentars deploys three independently versioned components:

- **Backend** (`apps/backend`) — Express API, Bun runtime
- **Frontend** (`apps/web`) — Next.js, Yarn
- **Contracts** (`apps/contracts`) — Soroban/Stellar WASM, immutable after deployment

A database migration or contract ABI change can silently break a deployed client
or block a rollback.  Every such change therefore requires explicit release notes
and passing compatibility checks before merging.

## What triggers the check

The `check-abi-migration-changelog.sh` CI script fails a PR if any of the
following files change without a corresponding CHANGELOG.md update:

| Changed files | Category |
|---|---|
| `apps/contracts/*.json` | Contract ABI |
| `apps/backend/database/migrations/*.sql` | Database schema |

## What to write in the changelog

Add an entry under `## [Unreleased]` with at least one of these headings:

### Additive changes (backwards-compatible)

These are safe to deploy without coordination.  Label them under `### Added`.

```markdown
### Added
- Migration 00025: add `cancelled_at` column to `bookings` (nullable, defaults
  to NULL for existing rows — backwards compatible with the deployed backend).
```

### Breaking changes (require coordinated rollout)

Label them under `### Changed` or `### Removed` and include:

1. **What changed** — the field, table, or contract entrypoint affected.
2. **Incompatible client versions** — which deployed version of backend/web/contract
   is no longer compatible after this change.
3. **Rollout order** — which component must be deployed first.
4. **Rollback boundary** — whether rolling back crosses this migration boundary
   (if so, a data migration or contract re-deploy may be required).

```markdown
### Changed
- Contract ABI: `create_booking` entrypoint now requires `escrow_agent` parameter.
  Incompatible with backend < 1.4.0.  Deploy backend 1.4.0 before this contract.
  Rolling back the contract is not possible post-deploy; rollback requires
  re-deploying the prior WASM from the release manifest.
```

## Release manifest

Every release generates `docs/releases/manifest-<version>.json` via:

```bash
bun run release:manifest --version X.Y.Z
```

The manifest records:
- `release.commit` — exact git SHA
- `database.latest_migration` — last applied migration filename
- `contracts.abi_sha256` — SHA-256 of each ABI file at release time
- `components.*` — per-component version

Use these fields during rollback to identify a compatible set.  See
`docs/releases/rollback.md` for the full procedure.

## Contract upgrade and data-migration strategy

Soroban contracts are immutable once deployed: a bug or ABI change cannot be
patched in place.  Upgrades therefore mean **deploying a successor contract**
and repointing backend/frontend integrations, while existing listings,
bookings, reviews, and escrow balances must remain continuous.

### Immutable vs migratable state

| State | Location | Classification | Handling on upgrade |
|---|---|---|---|
| Contract WASM / entrypoint ABI | `apps/contracts` | **Immutable** | New contract ID; old contract stays deployed read-only |
| Listings (`listing_id`, owner, price, metadata hash) | Contract storage | **Migratable** | Copied to successor via migration entrypoint; IDs preserved |
| Bookings (`booking_id`, listing ref, dates, status) | Contract storage | **Migratable** | Copied with original `booking_id`; payment refs preserved |
| Reviews (`review_id`, booking ref, rating) | Contract storage | **Migratable** | Copied with original `review_id` and booking reference |
| Escrow balances / token holdings | Stellar token contracts | **Immutable (external)** | Never re-created; successor is granted authority over existing escrow accounts |
| Off-chain mirror (backend DB) | `apps/backend/database` | **Migratable** | SQL migration adds `contract_id`/`contract_version` columns |

Rules:

- Identifiers (`listing_id`, `booking_id`, `review_id`) are **never
  renumbered** during migration; they are the continuity key across versions.
- Payment references (Stellar transaction hashes, escrow account addresses)
  are recorded verbatim in the successor contract and in the backend mirror.
- Anything not listed as migratable is treated as immutable and must be
  re-created explicitly, with a changelog entry.

### Upgrade authority

- Successor deployment and the `migrate_state` entrypoint require the
  **release admin key** (multisig, 2-of-3) recorded in the release manifest
  under `contracts.admin_public_key`.
- The migration entrypoint is callable **once** per successor contract; it
  sets a `migrated_from` field and then disables itself.
- No individual contributor key may deploy a contract that supersedes a
  released contract ID.

### Version identification

- Every contract exposes `version() -> (u32 major, u32 minor, u32 patch)` and
  `migrated_from() -> Option<Address>`.
- The backend stores `contract_id` and `contract_version` per chain
  interaction; the release manifest records `contracts.id` and
  `contracts.abi_sha256` for each deployed version.
- Old and new versions are therefore distinguishable from any booking or
  payment record: the stored `contract_id` identifies which contract wrote it.

### Compatibility window and dual-read / adapter approach

- The backend supports **N and N-1** contract versions for one release cycle
  (the compatibility window).  During the window:
  - **Writes** go to the successor contract only.
  - **Reads** are dual-read: the backend queries the successor first and falls
    back to the predecessor for records not yet migrated.
  - An **adapter layer** (`apps/backend/src/contracts/adapter`) normalises
    responses from both versions to the current internal shape, so API
    consumers see one schema.
- The window closes when the migration report shows zero unmigrated records;
  the predecessor adapter is then removed in the next release with a
  `### Removed` changelog entry.

### Testnet successor deployment and fixture rehearsal

1. Deploy the successor WASM to testnet; record its contract ID in the PR.
2. Run `migrate_state` against a snapshot of representative fixtures
   (at least: one listing with bookings, one cancelled booking, one booking
   with escrow released, one review per booking).
3. Verify:
   - every `listing_id`, `booking_id`, and `review_id` exists in the successor
     with identical field values;
   - booking → payment references resolve to the same Stellar transaction
     hashes;
   - escrow balances before and after migration are equal (no funds moved);
   - `version()` and `migrated_from()` return the expected values.
4. Attach the migration report and ABI diff to the release review; the release
   is blocked without this evidence.

### Cutover validation

- Compare record counts (listings, bookings, reviews) between predecessor and
  successor; any difference must be listed and explained.
- Replay a sample of recent bookings through the dual-read path and confirm
  identical API responses.
- Confirm the backend health check reports the successor `contract_id` and
  version.

### Rollback limitations

- **The contract deployment itself cannot be rolled back.**  The predecessor
  remains deployed and readable, but state written to the successor after
  cutover is not automatically present in the predecessor.
- Recovery means either (a) repointing the backend to the predecessor and
  accepting loss of post-cutover writes, or (b) deploying a corrected
  successor and re-running migration from both prior versions.
- Because of this, cutover and recovery steps must be **rehearsed on testnet**
  using the fixture set above before mainnet cutover, and the rehearsal result
  recorded in the release notes.

## Suppressing the check

If the ABI or migration change is already covered by a prior changelog entry
(e.g., a stacked PR), set the `BASE_SHA` environment variable to the commit
that already includes the changelog update:

```bash
BASE_SHA=<prior-commit> bash scripts/check-abi-migration-changelog.sh
```

Do not bypass the check with `git commit --no-verify`.
