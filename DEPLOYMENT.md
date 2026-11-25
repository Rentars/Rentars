# Rentars Deployment Guide

This document describes how to deploy the Rentars platform for both Stellar testnet and Stellar mainnet, including contracts, backend, frontend, monitoring, alerting, rollback, and validation.

## 1. Deployment Overview

Rentars is composed of three deployment layers:

- **Smart contracts**: Soroban contracts deployed on Stellar testnet or mainnet.
- **Backend**: Bun/Node API in `apps/backend` with Supabase/PostgreSQL and Redis.
- **Frontend**: Next.js application in `apps/web`, typically deployed to Vercel.

This guide assumes you have a working local repo clone and the following prerequisites installed:

- `bun` (backend runtime and package manager — see `apps/backend/package.json`)
- `node` (frontend tooling; the web workspace uses `yarn` — see `apps/web/package.json`)
- `rustup` + `cargo`
- `wasm32-unknown-unknown` Rust target
- `stellar-cli`
- A Supabase project or PostgreSQL database
- A Redis instance or managed Redis provider

### 1.1 Verified commands and ports (source of truth)

The commands below are the ones actually defined in the workspace. If a command
in this guide disagrees with a `package.json`, the `package.json` wins — please
open an issue.

| Area | Command | Where it is defined |
|---|---|---|
| Backend install | `bun install --frozen-lockfile` | `apps/backend/package.json` |
| Backend dev server | `bun run dev` | `apps/backend/package.json` |
| Backend tests | `bun test` | `apps/backend/package.json` |
| Backend contract tests | `bun run test:contract` | `apps/backend/package.json` |
| Migration validation | `bun run validate:migrations` | `apps/backend/package.json` |
| Web install | `yarn install --frozen-lockfile` | `apps/web/package.json` |
| Web dev server | `yarn dev` | `apps/web/package.json` |
| Web build | `yarn build` | `apps/web/package.json` |
| Web tests | `yarn test` | `apps/web/package.json` |
| Contract build | `cargo build --target wasm32-unknown-unknown --release` | `apps/contracts/Cargo.toml` |

**Ports**

| Service | Local | Production |
|---|---|---|
| Backend API | `3000` (`PORT=3000`) | `3000` behind TLS-terminating proxy |
| Frontend (Next.js) | `3001` (`next dev -p 3001`) | Vercel-managed (HTTPS 443) |
| Redis | `6379` | provider-managed |
| PostgreSQL / Supabase | `5432` (or Supabase pooler) | provider-managed |

Locally the frontend must point at the backend on port `3000`, e.g.
`NEXT_PUBLIC_API_URL=http://localhost:3000`. In production the frontend is
served from Vercel and calls the backend over HTTPS; the backend port is not
exposed directly to browsers.

---

## 2. Pre-Deployment Checklist

Before you deploy, confirm each item below:

- [ ] `apps/backend/.env` configured with production values
- [ ] `apps/web/.env.local` or Vercel environment variables configured
- [ ] Supabase database schema created and migrations applied
- [ ] Redis instance provisioned and reachable
- [ ] Stellar accounts created and funded for deployment
- [ ] Contract artifacts built in `apps/contracts/target/wasm32-unknown-unknown/release`
- [ ] Contract IDs recorded and stored securely
- [ ] Backend health endpoint (`/health`) returns success
- [ ] Frontend can connect to backend and Stellar RPC endpoints
- [ ] Secrets are stored in an encrypted secrets manager, not in Git

### 2.1 Preflight checks

Run these before touching staging or testnet. Every command is read-only and
safe to run repeatedly.

```bash
# 1. Runtime versions match the pinned toolchain (.nvmrc / .tool-versions)
node --version && bun --version && rustc --version
bash scripts/check-engines.sh

# 2. Environment files parse and required keys are present (values are NOT printed)
grep -q '^SUPABASE_URL=' apps/backend/.env || echo "MISSING: SUPABASE_URL"
grep -q '^JWT_SECRET='  apps/backend/.env || echo "MISSING: JWT_SECRET"

# 3. Database is reachable and migrations are current
psql "$DATABASE_URL" -c '\q' && echo "DB reachable"
cd apps/backend && bun run validate:migrations && cd ../..

# 4. Redis is reachable
redis-cli -u "$REDIS_URL" ping

# 5. Contract artifacts exist for the target network
ls apps/contracts/target/wasm32-unknown-unknown/release/*.wasm

# 6. Dependency trees install cleanly from lockfiles
cd apps/backend && bun install --frozen-lockfile && cd ../..
cd apps/web && yarn install --frozen-lockfile && cd ../..
```

Expected output: each step prints no `MISSING:` lines, `DB reachable`,
`validate:migrations` exits `0`, the `ls` lists three `.wasm` files, and both
installs finish without lockfile errors.

Never paste secret values into tickets, chat, or logs. Record only the key name
and whether it is present.

### 2.2 Post-deployment verification

After deploying to staging or testnet, confirm every item below and record the
observed output. Failures must be resolved before promotion.

```bash
# Backend liveness + dependency health
curl -sf "$BACKEND_URL/health" | jq .
curl -sf "$BACKEND_URL/health/deep" | jq .

# API contract compatibility against the published OpenAPI document
cd apps/backend && API_BASE_URL="$BACKEND_URL" bun run test:contract

# A real read path and an authentication guard
curl -sf "$BACKEND_URL/api/v1/properties?limit=1" | jq '.data | length'
curl -s -o /dev/null -w '%{http_code}\n' "$BACKEND_URL/api/v1/bookings"  # expect 401

# Frontend reachable and serving the expected build
curl -sfI "$FRONTEND_URL" | head -1
```

| Check | Expected | Rollback trigger |
|---|---|---|
| `/health` | `status: ok` | non-200 or degraded dependency |
| `/health/deep` | all dependencies `connected` | any dependency down |
| Contract tests | all pass | any undocumented change |
| `GET /properties` | 200 + JSON array | 5xx or malformed body |
| `GET /bookings` unauthenticated | 401 | unexpected 200 |

---

### 2.3 Deployment health gates (promotion blockers)

A release must not receive production traffic until every required gate below
passes. Gates are evaluated by `scripts/deploy-smoke.ts` (see
`docs/releases/smoke-checks.md` for the full check list and exit codes) and the
result is written to the release manifest. Exit codes: `0` = pass (promote),
`10` = blocked (hold traffic on the previous version), `20` = rollback.

**Environment safety:** every smoke check is read-only or uses simulation. No
check may create a real booking, charge a card, or transfer funds. Payment
checks run against Stellar testnet or a mocked payment provider only, and the
script refuses to run payment checks when `STELLAR_NETWORK=mainnet` unless
`PAYMENT_SMOKE_MODE=simulate` is set. Smoke checks must never be run with
production service-role keys that can write to live tables.

#### Preflight gates (before deploying)

| Gate | Check | Pass condition |
|---|---|---|
| API readiness | `GET $BACKEND_URL/health` and `/health/deep` on the candidate build in staging | `status: ok`, all dependencies `connected` |
| Frontend availability | `curl -sfI $FRONTEND_URL` on the preview deployment | HTTP 200, expected build/commit header |
| Database compatibility | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql` dry run against a restored snapshot, plus `bun run test:contract` | migrations apply cleanly, no undocumented API changes |
| Payment configuration | `PAYMENT_SMOKE_MODE=simulate bun run test:payments` | provider keys present, simulated intent succeeds, no live charge |

#### Post-deploy gates (before traffic promotion)

| Gate | Check | Pass condition |
|---|---|---|
| API readiness | `curl -sf "$BACKEND_URL/health" \| jq .` and `/health/deep` | `status: ok`, dependencies `connected` |
| Auth metadata | `curl -s -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/v1/bookings"` | `401` (auth guard active) |
| Property read | `curl -sf "$BACKEND_URL/api/v1/properties?limit=1" \| jq '.data \| length'` | `200` + JSON array |
| Frontend availability | `curl -sfI "$FRONTEND_URL" \| head -1` | HTTP 200 |
| Database compatibility | migration version matches the release manifest; read-only query succeeds | versions equal, query returns |
| Payment configuration | simulated payment path on testnet/mock | success, zero real funds moved |

**Promotion rule:** traffic promotion (canary → 100%) is blocked while any
required gate is failing or unrecorded. A failed required gate either holds the
release on the previous version or, if the failure is in a gate marked
`rollback` in `docs/releases/health-gates.json`, triggers the rollback runbook
in §7.9. Gates are re-run after any rollback before traffic is restored.

#### Rollback constraints for schema and contract changes

- **Schema:** migrations are forward-only in production. Roll back by restoring
  the pre-release backup (§7.4); do not hand-write down-migrations on live data.
  Destructive changes (drop/rename) must ship one release after the code that
  stops using them (§7.7).
- **Contracts:** Soroban contracts are immutable. A contract defect cannot be
  rolled back in place — use the fix-forward path in §7.3 (deploy a patched
  contract, update contract IDs, re-run post-deploy gates) or restore the
  previous contract IDs in the backend environment.
- **Fix-forward:** when a rollback is unsafe (e.g. a migration already applied
  and depended on by new data), document the decision in the release record,
  ship a forward fix behind a feature flag, and keep the failing gate red until
  the fix passes.

#### Release manifest

Every deployment writes a release manifest (see
`docs/releases/release-manifest.schema.json`) recording:

- `version` and `commit` — the deployed build
- `migration_state` — applied migration version / `setup.sql` checksum
- `contract_ids` — property listing, booking, review
- `health_results` — per-gate status, observed value, timestamp, and the
  `deploy-smoke.ts` exit code
- `rollback` — whether a rollback or fix-forward was taken, with approvers

The manifest is the source of truth for §8.1 release state tracking; a release
without a complete manifest is not considered promoted.

---

## 3. Stellar Testnet Setup
=======

### 3.1 Create and fund testnet accounts

1. Generate a Stellar keypair for your deployment admin account.
2. Fund the account using the Stellar testnet Friendbot:

```bash
stellar keys generate --output json > testnet-admin.json
export TESTNET_ADMIN_ADDRESS=$(jq -r '.address' testnet-admin.json)
stellar friendbot fund --address "$TESTNET_ADMIN_ADDRESS" --network testnet
```

3. Verify the account balance:

```bash
stellar account show --account "$TESTNET_ADMIN_ADDRESS" --network testnet
```

### 3.2 Build Soroban contract artifacts

From the workspace root:

```bash
cd apps/contracts
cargo build --target wasm32-unknown-unknown --release
```

Expected output: `Finished release [optimized] target(s)` and the following WASM
files present under `apps/contracts/target/wasm32-unknown-unknown/release/`:

- `property-listing.wasm`
- `booking.wasm`
- `review-contract.wasm`

Verify with `ls apps/contracts/target/wasm32-unknown-unknown/release/*.wasm`.

### 3.3 Deploy testnet contracts

Run from `apps/contracts` (the directory containing `target/`). Deploy each
contract to the Stellar testnet using `stellar contract deploy`:

```bash
cd apps/contracts
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/property-listing.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/booking.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/review-contract.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
```

Expected output: each command prints a contract ID (a `C...` address). Save all
three IDs; they are required in section 3.5.

### 3.4 Initialize the booking contract

The booking contract must be initialized with the property listing contract ID.

```bash
PROPERTY_LISTING_CONTRACT_ID=<property_listing_contract_id>
BOOKING_CONTRACT_ID=<booking_contract_id>
stellar contract invoke \
  --id "$BOOKING_CONTRACT_ID" \
  --source "$TESTNET_ADMIN_ADDRESS" \
  --network testnet \
  -- initialize \
  --admin "$TESTNET_ADMIN_ADDRESS" \
  --property_listing_contract_id "$PROPERTY_LISTING_CONTRACT_ID"
```

### 3.5 Record contract IDs

Update the backend environment with the deployed values:

```env
PROPERTY_LISTING_CONTRACT_ID=<property_listing_contract_id>
BOOKING_CONTRACT_ID=<booking_contract_id>
REVIEW_CONTRACT_ID=<review_contract_id>
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
```

If the frontend needs any contract metadata or network endpoints, ensure it is configured through the backend API or Vercel environment values.

---

## 4. Backend Deployment

### 4.1 Required backend environment variables

Use `apps/backend/.env.example` for local development and
`apps/backend/.env.production.example` as the template for staging and
production. Populate the following values:

- `PORT` — backend port, typically `3000`
- `NODE_ENV` — `production`
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `JWT_SECRET` — secure JWT signing secret
- `CORS_ORIGIN` — frontend origin URL
- `REDIS_URL` — Redis connection string (shared by all instances; see §4.3)
- `TRUSTED_PROXY_HOPS` — number of trusted proxy hops for client IP resolution (default `0`; see §4.4)
- `TRUSTED_PROXY_CIDRS` — optional comma-separated CIDRs of trusted proxies (recommended; see §4.4)
- `STELLAR_NETWORK` — `testnet` or `mainnet`
- `STELLAR_RPC_URL` — Soroban RPC URL
- `PROPERTY_LISTING_CONTRACT_ID` — on-chain contract ID
- `BOOKING_CONTRACT_ID` — on-chain contract ID
- `REVIEW_CONTRACT_ID` — on-chain contract ID
- `TRUSTLESS_WORK_API_URL` — escrow API URL
- `TRUSTLESS_WORK_API_KEY` — escrow API key
- `GEOCODING_API_KEY` — optional geocoding API key
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` — optional email settings

### 4.2 Database migration

The backend schema is managed under `apps/backend/database`. All migrations are
applied in the canonical order defined in
[`apps/backend/database/MIGRATIONS_NAMING.md`](apps/backend/database/MIGRATIONS_NAMING.md)
and listed in `setup.sql`. **Do not apply individual migration files by hand** —
always run the canonical entrypoint so ordering, duplicate-prefix handling, and
idempotency rules are preserved.

Validate the migration set before applying it:

```bash
cd apps/backend
bun run validate:migrations
```

Expected output: the validator exits `0` and reports no ordering, duplicate
prefix, or naming violations. A non-zero exit must be fixed before proceeding.

Then apply the canonical entrypoint:

```bash
cd apps/backend/database
# DATABASE_URL may be a direct PostgreSQL connection string or a Supabase pooler URL.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
```

Expected output: `psql` completes with exit code `0` and no `ERROR:` lines.
`-v ON_ERROR_STOP=1` makes `psql` abort on the first SQL error, matching the CI
pipeline (`.github/workflows/ci.yml`, job `rls-tests`). This is the only supported
migration path for staging and production.

If the backend is deployed inside Docker, ensure the DB credentials in
`SUPABASE_URL` or `DATABASE_URL` are reachable from the container.

### 4.3 Redis setup

Provide a managed Redis URL or run Redis locally.

For local Docker-based development, the repo includes `apps/backend/docker-compose.yml` and root `docker-compose.yml`:

- `redis` service is `redis:7-alpine`
- backend environment may use `REDIS_URL=redis://redis:6379`

For production, use a Redis provider and set `REDIS_URL` to the provider’s secure URL.

#### Redis requirements for shared rate-limit counters

Rate limiting is enforced with Redis-backed counters so that every backend
instance applies the same policy. When running more than one instance:

- **All instances must point at the same Redis database.** Do not use per-instance
  or per-AZ Redis replicas for counters; a counter written on instance A must be
  visible to instance B. Use a single logical Redis (or a cluster with a shared
  keyspace) for the rate-limit keys.
- **Do not use `FLUSHDB`/`FLUSHALL` on the production Redis** during rollbacks or
  maintenance (see §7.8). Flushing the database resets every rate-limit counter,
  which temporarily lets clients exceed their budgets. Prefer selective key
  deletion by pattern.
- **Do not configure eviction for rate-limit keys.** If Redis is configured with
  `maxmemory-policy allkeys-lru` (or similar), counters can be evicted under
  memory pressure, silently resetting budgets. Either provision enough memory, or
  isolate rate-limit keys in a dedicated Redis database/instance with
  `noeviction`.
- **Keep clocks and TTLs consistent.** Counters rely on Redis TTLs, not on
  instance clocks, so instances with skewed clocks still agree on window expiry.
  Ensure the Redis server itself has a stable clock (NTP) for TTL accuracy.
- **Replication lag is bounded, not zero.** With a replicated Redis, a failover
  can lose a small number of recent increments. Budgets are sized so that this
  window cannot be used to meaningfully exceed a limit; do not rely on exact
  counter equality across instances.
- **Fail closed or open deliberately.** If Redis is unreachable, the backend
  should apply its configured fallback (reject with `503`/`429` or allow with
  logging). Document the chosen behavior for your deployment and alert on Redis
  connectivity errors (§8.6).

### 4.4 Trusted proxy configuration for client identity

Rate limits are keyed by identity: the authenticated user ID when a valid token
is present, otherwise the client IP. Because the backend usually sits behind a
load balancer or reverse proxy, the client IP must be derived from forwarding
headers **only when those headers were written by a trusted hop**. Otherwise any
client can forge `X-Forwarded-For` and evade IP-based limits.

Configure the following backend environment variables to match your actual
deployment topology:

- `TRUSTED_PROXY_HOPS` — the number of proxy hops in front of the backend that
  are allowed to append to `X-Forwarded-For`. The backend reads the client IP
  from the right-hand side of the header, skipping exactly this many hops.
  Default is `0` (no proxy trusted; forwarding headers are ignored).
- `TRUSTED_PROXY_CIDRS` — optional comma-separated list of CIDR ranges for the
  proxies. When set, a forwarding header is only honored if the immediate peer
  address falls inside one of these ranges. This is the strongest option and is
  recommended for production.

Rules:

- **Never trust `X-Forwarded-For` blindly.** With `TRUSTED_PROXY_HOPS=0` and no
  CIDRs, the backend uses the socket peer address and ignores all forwarding
  headers. This is the safe default for direct-to-instance deployments.
- **Count hops from your own topology, not from the header.** A client can send
  any number of `X-Forwarded-For` entries; only the entries appended by your
  trusted proxies are meaningful. Set `TRUSTED_PROXY_HOPS` to the exact number of
  proxies between the internet and the backend.
- **Prefer CIDR pinning.** If your load balancer addresses are stable, set
  `TRUSTED_PROXY_CIDRS` so that a spoofed header from an untrusted peer is
  rejected even if the hop count is misconfigured.
- **Keep the setting identical on every instance.** Mixed configurations cause
  the same client to be keyed differently on different instances, splitting
  counters and weakening limits.

Common topologies:

| Topology | `TRUSTED_PROXY_HOPS` | `TRUSTED_PROXY_CIDRS` |
|---|---|---|
| Direct to backend (no proxy) | `0` | unset |
| Single load balancer (ALB, nginx, Caddy) | `1` | LB subnet range (recommended) |
| CDN → load balancer → backend | `2` | CDN + LB ranges |
| Kubernetes ingress → service → pod | `1` (or `2` if a sidecar proxy is present) | ingress controller pod CIDR |
| Vercel/Cloudflare in front of your own LB | `2` | CDN egress + LB ranges |

Verify the configuration after deployment by sending a request with a forged
header and confirming the limit is still applied to the real client:

```bash
# Forged X-Forwarded-For must NOT create a fresh budget
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -H "X-Forwarded-For: 203.0.113.$i" \
    "$BACKEND_URL/api/v1/properties?limit=1"
done
# Expect 429 responses once the real client's budget is exhausted,
# regardless of the rotating forged addresses.
```

Rate-limit responses include a `Retry-After` header (seconds) and a JSON body
with a `retryAfter` field so clients can back off safely. Do not expose internal
counter keys or raw IPs in these responses.

### 4.5 Backend startup commands

Local development (backend listens on `PORT=3000`):

```bash
cd apps/backend
bun install --frozen-lockfile
bun run dev
```

Expected output: the server logs that it is listening on port `3000`, and
`curl -sf http://localhost:3000/health` returns `{"status":"ok",...}`.

Docker-based startup:

```bash
docker compose -f docker-compose.yml up --build
```

Production deployment should use your preferred container or VM tooling, ensuring environment variables and health checks are configured. The backend
container listens on `3000`; terminate TLS at your proxy/load balancer and do not
publish the container port directly to the internet.

---

## 5. Frontend Deployment

### 5.1 Vercel configuration

Deploy `apps/web` as a Next.js application.

In Vercel:

- Set the root directory to `apps/web`
- Install command: `yarn install --frozen-lockfile`
- Build command: `yarn build`
- Output directory: `.next`

Locally the frontend runs on port `3001` (`yarn dev`); in Vercel it is served
over HTTPS on the default domain port.

### 5.2 Frontend environment variables

Use `apps/web/.env.example` as the template. Configure the following Vercel
environment variables for production or preview:

- `NEXT_PUBLIC_API_URL` — backend API endpoint (e.g. `https://api.rentars.app`; locally `http://localhost:3000`)
- `NEXT_PUBLIC_STELLAR_NETWORK` — `testnet` or `mainnet`
- `NEXT_PUBLIC_HORIZON_URL` — `https://horizon-testnet.stellar.org` or `https://horizon.stellar.org`
- `NEXT_PUBLIC_SOROBAN_RPC_URL` — `https://soroban-testnet.stellar.org` or `https://soroban-mainnet.stellar.org`
- `NEXT_PUBLIC_PASSKEY_RP_ID` — WebAuthn relying party ID for your domain
- `NEXT_PUBLIC_PASSKEY_RP_NAME` — `Rentars`
- `NEXT_PUBLIC_PASSKEY_ORIGIN` — frontend origin URL

If you deploy to Vercel, ensure the production values are set in the Production environment and preview values are set in Preview environments.

### 5.3 Frontend deployment validation

After deployment, verify:

- The site loads without console errors
- The API requests resolve correctly to the backend
- Stellar network selection uses the expected network
- Wallet integration can connect to Freighter or other supported Stellar wallet

---

## 6. Mainnet Deployment Checklist

> **⚠️ REQUIRES APPROVAL — GATED STEP**
>
> Mainnet deployment is **not** part of routine staging/testnet work. Do not
> execute any command in this section until you have:
>
> 1. A written approval from the engineering lead **and** the product lead.
> 2. A completed, signed-off testnet run using the section 2.2 verification.
> 3. Confirmation that the section 6.2 security review is closed.
>
> Record the approval reference (ticket ID) next to the release before
> proceeding. Unapproved mainnet actions are a rollback trigger.

Before switching from testnet to mainnet, complete this checklist:

- [ ] Review all smart contracts for security issues
- [ ] Schedule a third-party contract audit if possible
- [ ] Confirm admin keys are stored offline and rotated securely
- [ ] Confirm all production environment variables use `mainnet` values
- [ ] Update `STELLAR_NETWORK` to `mainnet`
- [ ] Update `STELLAR_RPC_URL` to `https://soroban-mainnet.stellar.org`
- [ ] Update `NEXT_PUBLIC_HORIZON_URL` to `https://horizon.stellar.org`
- [ ] Update `NEXT_PUBLIC_SOROBAN_RPC_URL` to `https://soroban-mainnet.stellar.org`
- [ ] Deploy and fund a mainnet Stellar admin account
- [ ] Deploy contracts and capture mainnet contract IDs
- [ ] Validate backend and frontend integration in a staging environment
- [ ] Confirm backup and rollback procedures are tested

### 6.1 Contract and key management

- Keep mainnet deployment keys offline when not in active use.
- Use dedicated Stellar accounts for contract deployment and administration.
- Never expose the secret seed in Git or logs.
- Restrict access to production secrets in your secrets manager.

### 6.2 Security and audit

Perform the following before mainnet launch:

- Static analysis for Smart Contract code
- Review backend input validation and authentication flows
- Verify CORS origins and JWT secret policies
- Verify `TRUSTED_PROXY_HOPS`/`TRUSTED_PROXY_CIDRS` match the production topology and that forged `X-Forwarded-For` headers cannot reset rate-limit budgets
- Verify all backend instances share one Redis for rate-limit counters and that eviction is disabled for those keys
- Conduct a security review of network access and firewall rules
- Confirm database permissions and Supabase RLS policies if used

---

## 7. Rollback Procedures

### 7.1 Backend rollback

- Use a previously tested backend release image or commit
- Redeploy the prior backend version to your hosting platform
- Restore the database from a recent backup if schema or data is corrupted
- For Docker deployments, use `docker compose down` and bring up the previous image tag

### 7.2 Frontend rollback

- In Vercel, promote a previous successful deployment from the deployment history
- Revert environment variable changes if the rollback requires the prior configuration

### 7.3 Contract rollback

Soroban contracts are immutable once deployed: a deployed contract's WASM cannot be
patched in place. The upgrade and migration policy — which contracts are
upgradeable, who may authorize an upgrade, how stored state and clients migrate,
and the rollback/forward-fix plan — is defined in section 7.10 and in
[`docs/releases/rollback.md`](docs/releases/rollback.md). In short, recovery from a
contract defect is one of:

- **Upgradeable contracts**: authorize an upgrade to a new WASM through the
  contract's admin/timelock path, running the tested state migration first.
- **Immutable contracts**: deploy a new contract version with a patched ABI,
  migrate state if a migration entry point exists, then update
  `PROPERTY_LISTING_CONTRACT_ID`, `BOOKING_CONTRACT_ID`, and `REVIEW_CONTRACT_ID`
  in the backend.
- Verify cross-contract calls and initialization again.

If contract addresses are updated, also update any frontend endpoints or settings that rely on them.

### 7.4 Database rollback

- Restore the latest clean backup using Supabase restore tools or PostgreSQL restore commands
- Use manual rollback SQL carefully if you understand schema dependencies
- If using `setup.sql`, restore the DB state from a backup rather than re-running DDL on live data

---

## 7.5 Release State Machine

Define a release state machine to track deployment and rollback states:

```
IDLE
  ↓ (deploy initiated)
DEPLOYING
  ↓ (deploy complete)
CANARY (optional 5% traffic)
  ↓ (gates pass)
STABLE (100% traffic)
  ↓ (rollback triggered)
ROLLING_BACK
  ↓ (rollback complete)
ROLLED_BACK
```

**State Transitions:**
- `IDLE → DEPLOYING`: Deployment initiated, health checks armed
- `DEPLOYING → CANARY`: Version deployed, canary traffic (5%) routed to new version
- `CANARY → STABLE`: Health gates pass for 15 min, traffic ramped to 100%
- `STABLE → ROLLING_BACK`: Manual rollback triggered or health gate failure
- `ROLLING_BACK → ROLLED_BACK`: Previous version restored, traffic restored

**State Storage:**
- Record current release state in a `releases` table or external system (e.g., Datadog, LaunchDarkly)
- Include fields: `version`, `state`, `timestamp`, `error_count`, `latency_p99`, `transaction_failure_rate`

---

## 7.6 Rollback Health Gates

Automated health gates determine if a rollout should pause or roll back.

The thresholds below are also kept in machine-readable form in [`docs/releases/health-gates.json`](docs/releases/health-gates.json). `scripts/release-health-gate.ts` evaluates a metrics snapshot against that file and exits `0` (proceed), `10` (pause), or `20` (rollback). If this section and the JSON file disagree, the JSON file is authoritative. Ownership of pause and rollback decisions, and the irreversible operations that limit rollback, are in [`docs/releases/rollback.md`](docs/releases/rollback.md).

### 7.6.1 Error Rate Gate

- **Threshold:** Error rate (5xx responses) exceeds 5% for 2 consecutive 1-minute windows
- **Action:** Pause canary traffic increase; alert ops; proceed to manual review
- **Recovery:** If error rate drops below 2% for 5 minutes, resume rollout

### 7.6.2 Latency Gate

- **Threshold:** Request latency (p99) exceeds 1000ms for 2 consecutive 1-minute windows
- **Action:** Pause canary traffic increase; alert ops
- **Recovery:** If p99 latency drops below 500ms for 5 minutes, resume rollout

### 7.6.3 Transaction Failure Rate Gate

- **Threshold:** Booking or payment transaction failures exceed 2% for 2 consecutive 1-minute windows
- **Action:** Immediate rollback; alert ops and finance team
- **Recovery:** None; manual investigation required before re-deploy

### 7.6.4 Database Connection Pool Gate

- **Threshold:** Connection pool usage exceeds 90% of max connections for 1 minute
- **Action:** Pause canary; alert ops
- **Recovery:** If usage drops below 70% for 5 minutes, resume rollout

### 7.6.5 Cache (Redis) Eviction Gate

- **Threshold:** Redis eviction rate exceeds 10 evictions/sec for 1 minute
- **Action:** Pause canary; alert ops
- **Recovery:** If eviction rate drops below 1 eviction/sec for 5 minutes, resume rollout

### 7.6.6 Stellar Contract Invocation Gate

- **Threshold:** Contract invocation failure rate exceeds 1% for 2 consecutive 1-minute windows
- **Action:** Immediate rollback; alert ops
- **Recovery:** Manual review of contract ABI and cross-contract calls before re-deploy

### Health Gate Implementation

```yaml
# Example health gate configuration (pseudocode)
health_gates:
  - name: error_rate
    metric: http_5xx_count / http_total_count
    threshold: 0.05
    window: 1m
    consecutive_windows: 2
    action: pause_rollout
    
  - name: latency_p99
    metric: request_latency_p99
    threshold: 1000ms
    window: 1m
    consecutive_windows: 2
    action: pause_rollout
    
  - name: transaction_failure
    metric: transaction_failures / total_transactions
    threshold: 0.02
    window: 1m
    consecutive_windows: 2
    action: rollback  # immediate, no pause
    
  - name: db_pool_usage
    metric: active_connections / max_connections
    threshold: 0.90
    window: 1m
    consecutive_windows: 1
    action: pause_rollout
    
  - name: redis_eviction
    metric: evictions_per_second
    threshold: 10
    window: 1m
    consecutive_windows: 1
    action: pause_rollout
    
  - name: contract_invocation
    metric: contract_failures / contract_invocations
    threshold: 0.01
    window: 1m
    consecutive_windows: 2
    action: rollback  # immediate
```

---

## 7.7 Schema Compatibility Rules

Ensure backward and forward compatibility during rollouts:

### Backward Compatibility (Old → New)

- **Add columns:** Always add with `DEFAULT` value; never make `NOT NULL` without back-fill
- **Remove columns:** Deprecate first; never remove in same release
- **Rename columns:** Create new column, migrate data, deprecate old, remove in next release
- **Rename tables:** Create new table, populate, deprecate old, remove in next release
- **Data type changes:** Create new column with new type, migrate data, swap names in next release

### Forward Compatibility (New → Old)

- **New features behind feature flags:** Allow easy disablement if rollback needed
- **RLS policy changes:** Test with both old and new policies before removing old
- **Contract ABI changes:** Deploy new contract, update backend to support both ABIs, remove old ABI in next release

### Schema Compatibility Testing

```sql
-- Test backward compatibility: migrate, then downgrade schema
BEGIN;
-- Run all migrations for new version
SELECT * FROM information_schema.tables WHERE table_schema = 'public';
-- Verify old app can still query
SELECT id, email FROM users LIMIT 1;
ROLLBACK;
```

---

## 7.8 Cache Invalidation During Rollback

Clear application cache to avoid stale data during rollback:

```bash
# Flush Redis cache completely (careful: affects all users)
redis-cli FLUSHDB

# Or: selective cache invalidation by key pattern
redis-cli KEYS "session:*" | xargs redis-cli DEL

# Verify cache is cleared
redis-cli DBSIZE
```

**Cache invalidation strategy:**
- On rollback, flush or invalidate all feature-flag and configuration caches
- Do NOT flush user session caches (preserves login state)
- Restart backend services after cache flush to clear in-memory caches

---

## 7.9 Rollback Runbook

### Quick Rollback (Backend)

```bash
# 1. Identify current release
CURRENT_VERSION=$(curl https://api.rentars.app/version | jq -r '.version')
PREVIOUS_VERSION=$(git describe --tags --abbrev=0 --exclude="$CURRENT_VERSION")

# 2. Check health gate status
curl https://ops.rentars.app/health-gates | jq '.status'

# 3. Trigger manual rollback (requires 2 approvers for prod)
curl -X POST https://ops.rentars.app/rollback \
  -H "Authorization: Bearer $ROLLBACK_TOKEN" \
  -d '{"target_version": "'$PREVIOUS_VERSION'", "reason": "health gate failure"}'

# 4. Monitor rollback progress
watch -n 5 'curl https://api.rentars.app/health | jq .'

# 5. Verify functionality
curl https://api.rentars.app/health -v
curl https://api.rentars.app/properties?limit=1

# 6. Clear cache
redis-cli -h $REDIS_HOST FLUSHDB

# 7. Document incident
# Create an incident report and notify team
```

### Rollback with Database Migration

```bash
# 1. Identify last good database state
BACKUP_ID=$(psql -h $DB_HOST -U $DB_USER -d rentars \
  -t -c "SELECT backup_id FROM backups ORDER BY created_at DESC LIMIT 2;" | tail -1)

# 2. Test restore in isolated DB
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER \
  -c "CREATE DATABASE rentars_rollback_test;"

# 3. Restore backup
pg_restore -h $VERIFY_DB_HOST -U $VERIFY_DB_USER \
  -d rentars_rollback_test backup_${BACKUP_ID}.dump

# 4. Verify schema and data
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_rollback_test \
  -c "SELECT version FROM schema_versions ORDER BY applied_at DESC LIMIT 1;"

# 5. Switch primary database (requires downtime)
# Backup current prod DB first
pg_dump -h $DB_HOST -U $DB_USER rentars > backup_prerollback_$(date +%s).dump

# Restore from backup
pg_restore -h $DB_HOST -U $DB_USER -d rentars backup_${BACKUP_ID}.dump

# 6. Cleanup test DB
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "DROP DATABASE rentars_rollback_test;"

# 7. Restart backend services
docker compose restart rentars-backend
```

### Rollback Stellar Contracts

```bash
# 1. Identify previous contract versions
stellar contract list --account $ADMIN_ACCOUNT --network mainnet

# 2. Update backend environment variables
# PROPERTY_LISTING_CONTRACT_ID=<previous_contract_id>
# BOOKING_CONTRACT_ID=<previous_contract_id>
# REVIEW_CONTRACT_ID=<previous_contract_id>

# 3. Restart backend to pick up new contract IDs
docker compose restart rentars-backend

# 4. Test contract interactions
curl -X POST https://api.rentars.app/bookings \
  -H "Content-Type: application/json" \
  -d '{"property_id": "test", "check_in": "2024-01-01"}'

# 5. Monitor for errors
curl https://api.rentars.app/contract-invocations?limit=10 | jq '.failures'
```

### Rollback Approvals

- **Rollback trigger:** Senior ops engineer or on-call engineering manager
- **Approval 1:** CTO or infrastructure lead
- **Approval 2:** Product lead or engineering manager
- **Documentation:** Incident post-mortem required within 24 hours

**Commands NEVER expose signing secrets:**

```bash
# ✗ WRONG: Never pass secrets via CLI args or env
psql -h $DB_HOST -U $DB_USER -p $DB_PASSWORD  # EXPOSED

# ✓ RIGHT: Use .pgpass or PGPASSWORD in secure manner
export PGPASSWORD="$DB_PASSWORD"  # Set only for command
psql -h $DB_HOST -U $DB_USER
unset PGPASSWORD

# ✓ RIGHT: Use AWS Secrets Manager or HashiCorp Vault
aws secretsmanager get-secret-value --secret-id prod/db/password | jq -r '.SecretString'
```

---

## 7.10 Dependency Updates and Vulnerability Triage

The backend (`apps/backend/package.json`), web (`apps/web/package.json`), and Rust
contract (`apps/contracts/Cargo.toml`) manifests carry large, actively updated
dependency sets. Updates must stay reproducible and must never be merged as blind
major-version bumps.

### 7.10.1 Update cadence

| Cadence | Scope | Owner |
|---|---|---|
| Weekly (Monday) | Dependabot grouped patch/minor PRs for backend, web, and Rust crates | Backend/web maintainers |
| Weekly (Monday) | Advisory scan results reviewed; new advisories triaged | Security on-call |
| Monthly | Major/runtime-sensitive updates evaluated individually | Component owner + reviewer |
| Quarterly | Exception register reviewed; expired exceptions closed | Security on-call |

### 7.10.2 Automated advisory scanning

Advisory scanning runs in CI and on a schedule:

- **CI:** `.github/workflows/dependency-audit.yml` runs on every pull request that
  touches a manifest or lockfile, and on a nightly schedule. It runs
  `bun audit` (backend), `yarn npm audit` (web), and `cargo audit`
  (contracts), and fails the job on any advisory at or above the configured
  severity threshold.
- **Dependabot:** `.github/dependabot.yml` opens grouped PRs for low-risk
  patch/minor updates only. Major and runtime-sensitive packages (Next.js/React,
  wallet SDKs, Supabase/PostgreSQL clients, and Rust contract crates) are
  excluded from grouping and raised as individual PRs.

Each finding must report the package name, installed version, patched version,
advisory ID, and severity so it is actionable without leaving CI.

### 7.10.3 Lockfile review expectations

- Lockfiles (`bun.lockb`, `yarn.lock`, `Cargo.lock`) are committed and reviewed
  in every dependency PR.
- Reviewers confirm the lockfile diff only contains the intended packages and
  their transitive additions/removals.
- Installs in CI and deployment use frozen lockfiles; a lockfile that does not
  match the manifest fails the build.

### 7.10.4 Severity-based response process

| Severity | Response window | Action |
|---|---|---|
| Critical | 24 hours | Patch or mitigate immediately; hotfix release |
| High | 7 days | Patch in the next scheduled release |
| Moderate | 30 days | Patch in a normal update cycle |
| Low | Next quarterly review | Track and batch with routine updates |

Every remediation PR must pass the relevant test suites before merge (see
verification commands below). If a fix cannot be applied within the window, an
exception must be recorded (see 7.10.6).

### 7.10.5 Avoiding blind major-version upgrades

Major and runtime-sensitive upgrades are never auto-merged. For each of the
following, open a dedicated PR with a compatibility note and run the relevant
suite:

- **Framework (Next.js/React, Bun/Node runtime):** check release notes for
  breaking changes, run `apps/web` build and `apps/backend` contract tests.
- **Wallet SDKs (Stellar/Freighter/passkey):** verify connect, sign, and submit
  flows against testnet before merge.
- **Database clients (Supabase/PostgreSQL):** confirm migration compatibility and
  run the `rls-tests` job.
- **Rust contract crates (soroban-sdk and friends):** rebuild WASM, run
  `cargo test`, and re-verify contract ABI and cross-contract calls.

### 7.10.6 Verification commands

```bash
# Backend: frozen install, audit, and tests
cd apps/backend
bun install --frozen-lockfile
bun audit
bun run test

# Web: frozen install, audit, and build
cd apps/web
yarn install --frozen-lockfile
yarn npm audit --severity high
yarn build

# Contracts: audit, tests, and WASM build
cd apps/contracts
cargo audit
cargo test
cargo build --target wasm32-unknown-unknown --release
```

### 7.10.7 Exception process

When a vulnerability cannot be remediated within its response window:

1. Record the exception in `docs/security/dependency-exceptions.md` with the
   package, advisory ID, severity, reason, compensating control, owner, and an
   **expiration date** (no more than 90 days out).
2. Reference the exception in the PR or issue that tracks the finding.
3. Suppress the advisory in the scanner only with a matching, dated ignore entry
   so it is visible in review.
4. Review all open exceptions at the quarterly review; expired exceptions must be
   remediated or re-justified with a new expiration date.

Exceptions are documented and reviewed — never silently ignored.

---

## 8. Monitoring and Alerting
=======

### 8.1 Release State Tracking

Operators must be able to identify the active release at any time:

```bash
# Check currently deployed version
curl https://api.rentars.app/version | jq '.'
# Response: { "version": "v1.2.3", "deployed_at": "2024-01-15T10:30:00Z", "commit": "abc123..." }

# Check active migration version
psql -h $DB_HOST -U $DB_USER -d rentars \
  -c "SELECT migration_version FROM schema_versions ORDER BY applied_at DESC LIMIT 1;"

# Check active contract IDs
curl https://api.rentars.app/contracts | jq '.contracts | {booking, property_listing, review}'

# Check cache version
redis-cli INFO replication | grep role
redis-cli GET "config:cache_version"
```

### 8.2 Release Health Gates Monitoring

Monitor the health gates in real-time:

```bash
# Check all active health gates
curl https://ops.rentars.app/health-gates | jq '.'

# Check specific gate status
curl https://ops.rentars.app/health-gates/error_rate | jq '.{status, current_value, threshold}'

# Get rollback decision history
curl https://ops.rentars.app/rollback-decisions | jq '.[] | {timestamp, gate, decision, reason}' | head -20
```

**Expected response format:**
```json
{
  "status": "green",
  "release_state": "STABLE",
  "gates": [
    {
      "name": "error_rate",
      "status": "pass",
      "current_value": "0.002",
      "threshold": "0.05",
      "window": "1m",
      "last_check": "2024-01-15T10:35:12Z"
    },
    {
      "name": "latency_p99",
      "status": "pass",
      "current_value": "425ms",
      "threshold": "1000ms",
      "window": "1m",
      "last_check": "2024-01-15T10:35:12Z"
    }
  ]
}
```

### 8.3 Health checks

Expose and monitor the backend health endpoint:

- `GET /health` — returns service health and version info
- `GET /health/deep` — includes database, Redis, contract connectivity checks
- `GET /health-gates` — returns current status of all rollout health gates

For Docker or hosted environments, configure uptime checks and automatic restarts if health checks fail.

**Health check response format:**
```json
{
  "status": "ok",
  "version": "v1.2.3",
  "uptime_seconds": 3600,
  "dependencies": {
    "database": "connected",
    "redis": "connected",
    "stellar": "connected"
  }
}
```

### 8.4 Logging and error monitoring

- Send backend logs to a centralized provider (e.g. Datadog, Logflare, Papertrail)
- Alert on repeated 5xx API errors and contract invocation failures
- Monitor Redis errors and connection failures
- Monitor Supabase database errors and slow queries

### 8.5 Metrics to monitor

**Health Gate Metrics (Rollout Monitoring):**
- HTTP 5xx error rate (target: < 5% for 2 consecutive 1-minute windows)
- Request latency p99 (target: < 1000ms)
- Transaction failure rate (target: < 2% for critical operations)
- Database connection pool usage (target: < 90%)
- Redis eviction rate (target: < 10 evictions/sec)
- Stellar contract invocation success rate (target: > 99%)

**System Metrics:**
- API request rate and error rate
- Backend latency (p50, p95, p99)
- Redis memory usage and connection counts
- Database connection pool usage and query performance
- Stellar transaction failure rate
- Contract invocation latency

### 8.6 Alerting

Set alerts for health gates:

- Error rate exceeds 5% (pause rollout)
- Latency p99 exceeds 1000ms (pause rollout)
- Transaction failure rate exceeds 2% (immediate rollback)
- Database pool usage exceeds 90% (pause rollout)
- Redis eviction rate exceeds 10 evictions/sec (pause rollout)
- Contract invocation failure rate exceeds 1% (immediate rollback)

**Operational alerts:**
- Backend service down or unhealthy
- `REDIS_URL` or database connectivity errors
- Spike in API 500 responses
- Contract initialization failures
- Unexpected drops in booking or listing traffic
- Rollback triggered (manual notification to on-call)

### 8.7 Platform-specific monitoring

- Vercel: use deployment notifications and uptime checks
- Supabase: use database metrics, query performance charts, and alerts
- Redis provider: configure memory, CPU, and eviction alerts

---

## 8.8 Backup Verification and Restore Drills

A backup that has never been restored is not a verified recovery mechanism.
Rental and payment history require explicit recovery objectives.

### 8.8.1 Recovery objectives

| Target | Value | Owner |
|---|---|---|
| RPO (database) | 15 minutes (point-in-time recovery) | Database owner |
| RTO (database) | 2 hours to a verified, isolated restore | On-call + database owner |
| RPO (object storage) | 24 hours | Infrastructure lead |
| RTO (object storage) | 4 hours | Infrastructure lead |
| RPO (configuration/secrets) | On change (versioned) | Security on-call |
| RTO (configuration) | 1 hour | On-call |

### 8.8.2 Backup sources and retention

- **Database:** Supabase automated backups / PostgreSQL base backups plus WAL for
  point-in-time recovery. Retain daily backups for 30 days and weekly for 90 days.
- **Object storage:** versioned bucket with lifecycle rules; retain 30 days.
- **Configuration:** environment variables and secrets live in the secrets
  manager with version history; never copied into developer environments.

### 8.8.3 Automated backup validation

Where the platform supports it, schedule a validation job that confirms the most
recent backup exists, is non-zero, and passes a checksum. Failures alert the
on-call engineer.

### 8.8.4 Restore drill procedure (isolated, sanitized)

1. Provision an isolated database and storage bucket that is not reachable from
   production.
2. Restore the most recent backup into the isolated database.
3. Do **not** copy production secrets. Use throwaway credentials for the drill
   environment only.
4. Verify migration compatibility: confirm the restored schema version matches
   the expected migration and that `setup.sql` is idempotent against it.
5. Run key integrity queries to confirm core booking/payment relationships:

```sql
-- Bookings reference existing properties and users
SELECT count(*) FROM bookings b
  LEFT JOIN properties p ON p.id = b.property_id
  WHERE p.id IS NULL;

-- Payments reference existing bookings
SELECT count(*) FROM payments pay
  LEFT JOIN bookings b ON b.id = pay.booking_id
  WHERE b.id IS NULL;

-- No orphaned rental history
SELECT count(*) FROM bookings WHERE status IS NULL;
```

All counts must be zero (or match the documented baseline) before the drill is
considered successful.

### 8.8.5 Drill schedule and evidence

- Restore drills run **quarterly**, and after any major schema or infrastructure
  change.
- Record the drill date, backup timestamp restored, duration, verification query
  results, and any remediation actions in the operational runbook/issue tracker.
- Failed drills produce a remediation action with an owner and due date.

---

## 9. Validation Steps
=======

### 9.1 Step-by-step verification checklist

Run these in order and record the observed output. A step is only "verified"
when the expected output is observed.

| # | Step | Command | Expected output |
|---|---|---|---|
| 1 | Toolchain | `bash scripts/check-engines.sh` | exit `0`, versions match pins |
| 2 | Backend install | `cd apps/backend && bun install --frozen-lockfile` | exit `0`, no lockfile errors |
| 3 | Web install | `cd apps/web && yarn install --frozen-lockfile` | exit `0`, no lockfile errors |
| 4 | Migration validation | `cd apps/backend && bun run validate:migrations` | exit `0`, no violations |
| 5 | Migrations applied | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/backend/database/setup.sql` | exit `0`, no `ERROR:` |
| 6 | Backend tests | `cd apps/backend && bun test` | all tests pass |
| 7 | Contract tests | `cd apps/backend && bun run test:contract` | all tests pass |
| 8 | Web tests | `cd apps/web && yarn test` | all tests pass |
| 9 | Contract build | `cd apps/contracts && cargo build --target wasm32-unknown-unknown --release` | three `.wasm` files present |
| 10 | Backend health | `curl -sf "$BACKEND_URL/health"` | `status: ok` |
| 11 | Deep health | `curl -sf "$BACKEND_URL/health/deep"` | all dependencies `connected` |
| 12 | Auth guard | `curl -s -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/v1/bookings"` | `401` |
| 13 | Frontend | `curl -sfI "$FRONTEND_URL"` | `HTTP/2 200` |

### 9.2 Capability status

The table below distinguishes code-complete capabilities from those verified in
a deployed environment. Do not describe an item as production-ready until it has
been verified in staging/testnet and recorded here.

| Capability | Status | Notes |
|---|---|---|
| Backend API + tests | Code-complete | Verified locally and in CI |
| Database migrations (`setup.sql`) | Code-complete | Verified locally and in CI (`rls-tests`) |
| Frontend build + tests | Code-complete | Verified locally and in CI |
| Soroban contract build | Code-complete | Verified locally |
| Testnet contract deploy | Deployment-verified | Requires funded testnet account |
| Staging backend/frontend deploy | Deployment-verified | Follow section 2.2 |
| Mainnet contract deploy | **Not verified — gated** | Requires approval (section 6) |
| Mainnet backend/frontend | **Not verified — gated** | Requires approval (section 6) |
| Rollback drill | Not verified | Must be completed before mainnet |

### 9.3 Documentation acceptance

To confirm this guide is accurate, verify:

1. ✅ `DEPLOYMENT.md` documents testnet setup, backend deployment, frontend deployment, and mainnet checklist
2. ✅ Release state machine (IDLE → DEPLOYING → CANARY → STABLE → ROLLED_BACK) defined
3. ✅ Health gates configured with error rate, latency, transaction failure, and infrastructure thresholds
4. ✅ Schema compatibility rules documented for add/remove/rename operations
5. ✅ Cache invalidation procedure defined for rollback scenarios
6. ✅ Rollback runbook includes backend, database, and contract rollback steps
7. ✅ All operators can identify: current version, active migration, contract IDs, and cache version
8. ✅ Staging rollback drill completed and documented in CI/CD pipeline
9. ✅ Health gates monitoring configured in observability platform
10. ✅ Rollback approval process requires 2 approvers for production
11. ✅ No commands expose signing secrets in logs or CLI arguments
12. ✅ Dependency advisory scanning runs in CI and on schedule with actionable package/severity output
13. ✅ Major/runtime-sensitive upgrades are reviewed individually, not auto-merged
14. ✅ Dependency exceptions are documented with expiration dates and reviewed quarterly
15. ✅ RPO/RTO targets and owners are documented for database, storage, and configuration
16. ✅ A restore drill into an isolated, sanitized environment has been completed and recorded

If all checks are satisfied, deployment automation is production-ready for
staging/testnet. Mainnet remains gated behind the approval process in section 6
until the capability status table in section 9.2 records it as
deployment-verified.
