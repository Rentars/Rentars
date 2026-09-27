# Contract upgrade sequencing

This document describes how to roll out new Soroban contract WASM and ABI versions without breaking running backends or skipping compatibility checks.

## Registry source of truth

Canonical contract metadata lives in [`apps/contracts/registry/contract-registry.json`](../../apps/contracts/registry/contract-registry.json). Each entry records:

- **contractKey** — logical contract (`property-listing`, `booking`, `review`)
- **network** — `testnet` or `mainnet`
- **contractId** — on-chain ID operators configure in env (`*_CONTRACT_ID`)
- **wasmHash** — SHA-256 of deployed WASM (update after deploy)
- **abiVersion** / **abiSha256** — ABI shipped with the app (synced by `yarn release:manifest`)
- **initDependencies** — other registry keys that must be deployed first
- **compatibleAppVersions** — backend/app semver values allowed to talk to this deployment
- **allowedUpgradeContractIds** — previous IDs permitted during a staged migration

At startup, when `BLOCKCHAIN_FEATURES_ENABLED=true`, the backend loads the registry and **refuses to start** if:

1. Any configured contract ID is unknown for the current network (and not listed as an upgrade candidate).
2. The running app version is not listed in `compatibleAppVersions` for that contract.
3. On-disk ABI JSON hashes do not match the registry (stale build).

Public, non-sensitive metadata is exposed at `GET /health/contracts` (ABI version, truncated hashes, release notes — no contract IDs or secrets).

## Recommended upgrade sequence

### 1. Develop and test

1. Implement contract changes in `apps/contracts/`.
2. Regenerate ABI JSON artifacts and run contract CLI tests.
3. Run `yarn release:manifest` to refresh ABI hashes in the registry and produce a release manifest.

### 2. Deploy WASM

1. Build optimized WASM for each changed contract.
2. Deploy to **testnet** first; record the new `contractId` and WASM SHA-256.
3. Update the registry entry (or add a new row) with `wasmHash`, `contractId`, and `releaseNotes`.
4. If replacing an existing deployment, add the **previous** `contractId` to `allowedUpgradeContractIds` on the new canonical entry so backends can migrate without a hard cutover.

### 3. Align backend release

1. Add the backend semver (from `apps/backend/package.json` or release tag) to `compatibleAppVersions` for every affected registry entry.
2. Set env vars to the new IDs (or keep the old ID while it remains in `allowedUpgradeContractIds`).
3. Deploy backend with `BLOCKCHAIN_FEATURES_ENABLED=true` and verify startup passes registry validation.
4. Confirm `GET /health/contracts` shows expected ABI/WASM prefixes for operators.

### 4. Staged production cutover

1. Repeat deploy on **mainnet**; update mainnet registry placeholders with real IDs and WASM hashes.
2. Deploy backend to staging with mainnet env; confirm health and a smoke booking/listing path.
3. Remove retired IDs from `allowedUpgradeContractIds` only after all environments use the new canonical ID.
4. Archive the prior release manifest under `docs/releases/manifest-*.json` for rollback reference (see [rollback.md](./rollback.md)).

## Rollback

- Point env `*_CONTRACT_ID` variables back to the previous on-chain deployment.
- Ensure that previous ID is still listed in `allowedUpgradeContractIds` or restore the prior registry row from git.
- Deploy the previous backend version whose semver remains in `compatibleAppVersions`.

## Operator checklist

- [ ] Registry updated with WASM hash and contract IDs
- [ ] `yarn release:manifest` run so ABI SHA-256 matches repo ABIs
- [ ] App version added to `compatibleAppVersions`
- [ ] Staging startup succeeds with blockchain features enabled
- [ ] `/health/contracts` reviewed before production traffic
