# Compatibility Requirements for ABI and Schema Changes

## Why this matters

Rentars deploys three independently versioned components:

- **Backend** (`apps/backend`) — Express API, Bun runtime
- **Frontend** (`apps/web`) — Next.js, Yarn
- **Contracts** (`apps/contracts`) — Soroban/Stellar WASM, immutable after deployment
  unless explicitly declared upgradeable (see [Contract upgrade and migration policy](#contract-upgrade-and-migration-policy))

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
| `apps/contracts/upgrade-policy.json` | Contract upgradeability / authority |

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

The rollback boundary is mandatory for every breaking change.  State explicitly
whether the change is **reversible** (rollback to the prior component version is
safe), **fix-forward only** (rollback would corrupt data or leave an
incompatible ABI), or **requires a data migration** to roll back.  This
declaration is what the deployment health gates and rollback runbook rely on
when deciding whether to promote or roll back (see `docs/releases/rollback.md`).

```markdown
### Changed
- Contract ABI: `create_booking` entrypoint now requires `escrow_agent` parameter.
  Incompatible with backend < 1.4.0.  Deploy backend 1.4.0 before this contract.
  Rolling back the contract is not possible post-deploy; rollback requires
  re-deploying the prior WASM from the release manifest.
  Rollback boundary: **fix-forward only** — the new ABI is immutable once
  deployed; recovery requires re-deploying the prior WASM recorded in the
  release manifest.
```

## Contract upgrade and migration policy

Deployed Soroban contracts and their stored state may outlive application
versions.  The policy below makes upgradeability and upgrade authority explicit
so operators can always answer: *can this contract be upgraded, and who may
authorize it?*

### Upgradeability and authority

Every contract's upgradeability is declared in
`apps/contracts/upgrade-policy.json`.  Each entry records:

- `contract` — contract name / WASM artifact
- `upgradeable` — `true` or `false` (immutable)
- `admin` — the address (or multisig) authorized to upgrade, or `null` when
  immutable
- `timelock_seconds` — delay between upgrade proposal and execution (`0` when
  no timelock applies)
- `migration_entrypoint` — the contract entrypoint that migrates stored state
  between versions, or `null` when no migration is supported
- `storage_version` — the current on-chain storage schema version

Immutable contracts must set `upgradeable: false`, `admin: null`, and
`migration_entrypoint: null`.  Any change to this file is a breaking change and
must be documented in the changelog (see below).

### Client compatibility check

Before release, run the compatibility check against the release manifest and
the current client version assumptions:

```bash
bun run scripts/check-contract-compatibility.ts --manifest docs/releases/manifest-<version>.json
```

The script compares the recorded `contracts.abi_sha256` values and
`storage_version` entries against the ABIs and versions the backend and web
clients were built against.  It exits non-zero when a deployed client is
incompatible with the contracts in the manifest, so incompatibility is detected
before release rather than after deployment.  This check runs in CI on every
release PR and must pass before the manifest is published.

### Required changelog content for upgrades and migrations

Contract upgrades and state migrations are breaking changes.  In addition to
the standard fields above, the changelog entry must state:

1. **Upgradeability** — whether the contract is upgradeable and, if so, the
   `admin` and `timelock_seconds` from `upgrade-policy.json`.
2. **State migration** — the `migration_entrypoint` invoked, the
   `storage_version` transition (e.g. `v1 → v2`), and confirmation that the
   migration was tested against old state in a sandbox.
3. **Rollback / forward-fix plan** — whether rollback is possible (immutable
   contracts cannot roll back) and, if not, the forward-fix procedure.

```markdown
### Changed
- Contract upgrade: `rent_escrow` upgraded from storage `v1` to `v2`.
  Upgradeable; admin `G...` with a 48h timelock.  State migrated via
  `migrate_v2`, tested against a v1 sandbox snapshot.  Rollback is not
  supported after `migrate_v2` runs; forward-fix only.
```

## Release manifest

Every release generates `docs/releases/manifest-<version>.json` via:

```bash
bun run release:manifest --version X.Y.Z
```

The manifest records:
- `release.commit` — exact git SHA
- `release.version` — the release version (`X.Y.Z`)
- `database.latest_migration` — last applied migration filename
- `database.migration_state` — applied/pending migration set at release time
- `contracts.abi_sha256` — SHA-256 of each ABI file at release time
- `components.*` — per-component version
- `health_gates.preflight` — results of the pre-promotion smoke checks
  (API readiness, frontend availability, database compatibility, payment
  configuration)
- `health_gates.post_deploy` — results of the post-deploy smoke checks
- `health_gates.passed` — overall gate outcome that authorised traffic promotion

The manifest is the authoritative record linking version, migration state, and
health-gate results for a deployment.  A release must not be promoted unless
`health_gates.passed` is `true`; a failed required check blocks promotion or
triggers the documented rollback.  Use these fields during rollback to identify
a compatible set and to confirm the migration state matches the target version.
See `docs/releases/rollback.md` for the full procedure.

## Suppressing the check

If the ABI or migration change is already covered by a prior changelog entry
(e.g., a stacked PR), set the `BASE_SHA` environment variable to the commit
that already includes the changelog update:

```bash
BASE_SHA=<prior-commit> bash scripts/check-abi-migration-changelog.sh
```

Do not bypass the check with `git commit --no-verify`.

## Dependency compatibility and exceptions

Dependency updates are governed by the policy in
[`DEPLOYMENT.md`](../../DEPLOYMENT.md) and are scanned by the
[`dependency-audit` workflow](../../../.github/workflows/dependency-audit.yml).
This section covers the compatibility expectations that apply on top of that
policy.

### Runtime-sensitive packages

The following packages are **runtime-sensitive**: a major-version bump (or, in
some cases, a minor bump) can change runtime behavior, wire formats, or
deployment requirements.  They must **not** be included in grouped automated
updates and must be upgraded in dedicated PRs with the relevant tests passing.

| Component | Package(s) | Why it is sensitive |
|---|---|---|
| Frontend framework | `next`, `react`, `react-dom` | App Router / RSC behavior, build output, routing |
| Wallet SDK | `@stellar/stellar-sdk`, `@stellar/freighter-api`, wallet-kit packages | Transaction signing, XDR encoding, network passphrase handling |
| Database client | `@supabase/supabase-js`, `pg` / `postgres` | Query semantics, connection pooling, auth token handling |
| Backend runtime | `express`, `redis` / `ioredis` | Middleware ordering, session/cache key formats |
| Media pipeline | `sharp` | Native binary ABI, image encoding output |
| Contracts | Soroban crates (`soroban-sdk`, `stellar-*`) in `apps/contracts/Cargo.toml` | On-chain ABI, WASM size limits, host function availability |

Low-risk patch/minor updates to non-sensitive packages may be grouped (see the
policy in `DEPLOYMENT.md`).  Major updates and any update to the packages above
are always separate PRs.

### Required tests for updates

Every dependency update PR must pass the checks relevant to the component it
touches before merge:

- **Backend** — `bun test` in `apps/backend`, plus the migration/ABI changelog
  check if schema or contract files change.
- **Frontend** — `yarn test` and `yarn build` in `apps/web` (a build failure is
  the most common signal of a Next.js/React incompatibility).
- **Contracts** — `cargo test` and `cargo build --target wasm32-unknown-unknown`
  in `apps/contracts`; verify the resulting WASM size stays within the network
  limit.
- **Wallet SDK / database client** — run the integration tests that exercise
  signing and query paths, not just unit tests.

An update that changes a lockfile must commit the updated lockfile
(`bun.lockb`, `yarn.lock`, or `Cargo.lock`) in the same PR so builds remain
reproducible.

### Approved exceptions

A vulnerability that cannot be remediated immediately (no fixed version, or a
fix blocked by a runtime-sensitive upgrade) may be granted a time-boxed
exception.  Exceptions are **documented, not silently ignored**.  Record each
one in the table below:

| Advisory | Package | Severity | Reason for exception | Owner | Expires |
|---|---|---|---|---|---|
| _(none)_ | | | | | |

Rules for exceptions:

- Every exception has a named **owner** and an **expiration date** (no more than
  90 days out).
- The `dependency-audit` workflow fails once an exception passes its expiration
  date, forcing review.
- Exceptions are reviewed at each release; an expired or stale exception must be
  renewed with justification or resolved.
- Exceptions affecting runtime-sensitive packages require sign-off from the
  component owner listed in `DEPLOYMENT.md`.