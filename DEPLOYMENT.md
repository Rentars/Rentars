# Rentars Deployment Guide

This document describes how to deploy the Rentars platform for both Stellar testnet and Stellar mainnet, including contracts, backend, frontend, monitoring, alerting, rollback, and validation.

## 1. Deployment Overview

Rentars is composed of three deployment layers:

- **Smart contracts**: Soroban contracts deployed on Stellar testnet or mainnet.
- **Backend**: Bun/Node API in `apps/backend` with Supabase/PostgreSQL and Redis.
- **Frontend**: Next.js application in `apps/web`, typically deployed to Vercel.

This guide assumes you have a working local repo clone and the following prerequisites installed:

- `bun`
- `node` / `npm`
- `rustup` + `cargo`
- `wasm32-unknown-unknown` Rust target
- `stellar-cli`
- A Supabase project or PostgreSQL database
- A Redis instance or managed Redis provider

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

---

## 3. Stellar Testnet Setup

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

The generated WASM files will be in:

- `apps/contracts/target/wasm32-unknown-unknown/release/property-listing.wasm`
- `apps/contracts/target/wasm32-unknown-unknown/release/booking.wasm`
- `apps/contracts/target/wasm32-unknown-unknown/release/review-contract.wasm`

### 3.3 Deploy testnet contracts

Deploy each contract to the Stellar testnet using `stellar contract deploy`:

```bash
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/property-listing.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/booking.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/review-contract.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
```

Save the contract IDs returned by each command.

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

Use `apps/backend/.env.example` as a template and populate the following values:

- `PORT` — backend port, typically `3000`
- `NODE_ENV` — `production`
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `JWT_SECRET` — secure JWT signing secret
- `CORS_ORIGIN` — frontend origin URL
- `REDIS_URL` — Redis connection string
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

The backend schema is managed under `apps/backend/database`.

Run all migrations with PostgreSQL / Supabase credentials:

```bash
cd apps/backend/database
psql -U postgres -d rentars -f setup.sql
```

If your environment is Supabase and the project already exists, run the SQL from `setup.sql` and then apply any additional migrations manually:

```bash
psql -U postgres -d rentars -f apps/backend/database/migrations/00009_create_reviews_table.sql
psql -U postgres -d rentars -f apps/backend/database/migrations/00010_create_wishlists_table.sql
psql -U postgres -d rentars -f apps/backend/database/migrations/00011_create_notifications_table.sql
psql -U postgres -d rentars -f database/migrations/001_create_sync_tables.sql
```

If the backend is deployed inside Docker, ensure the DB credentials in `SUPABASE_URL` or `DATABASE_URL` are reachable from the container.

### 4.3 Redis setup

Provide a managed Redis URL or run Redis locally.

For local Docker-based development, the repo includes `apps/backend/docker-compose.yml` and root `docker-compose.yml`:

- `redis` service is `redis:7-alpine`
- backend environment may use `REDIS_URL=redis://redis:6379`

For production, use a Redis provider and set `REDIS_URL` to the provider’s secure URL.

### 4.4 Backend startup commands

Local development:

```bash
cd apps/backend
yarn install
bun run dev
```

Docker-based startup:

```bash
docker compose -f docker-compose.yml up --build
```

Production deployment should use your preferred container or VM tooling, ensuring environment variables and health checks are configured.

---

## 5. Frontend Deployment

### 5.1 Vercel configuration

Deploy `apps/web` as a Next.js application.

In Vercel:

- Set the root directory to `apps/web`
- Select `yarn install` or `npm install` as build step if needed
- Build command: `yarn build`
- Output directory: `.next`

### 5.2 Frontend environment variables

Configure the following Vercel environment variables for production or preview:

- `NEXT_PUBLIC_API_URL` — backend API endpoint (e.g. `https://api.rentars.app`)
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

Smart contracts on Stellar are immutable. If a contract bug is discovered in production:

- Deploy a new contract version with a patched ABI
- Update `PROPERTY_LISTING_CONTRACT_ID`, `BOOKING_CONTRACT_ID`, and `REVIEW_CONTRACT_ID` in the backend
- Verify cross-contract calls and initialization again

If contract addresses are updated, also update any frontend endpoints or settings that rely on them.

### 7.4 Database rollback

- Restore the latest clean backup using Supabase restore tools or PostgreSQL restore commands
- Use manual rollback SQL carefully if you understand schema dependencies
- If using `setup.sql`, restore the DB state from a backup rather than re-running DDL on live data

---

## 8. Monitoring and Alerting

### 8.1 Health checks

Expose and monitor the backend health endpoint:

- `GET /health`

For Docker or hosted environments, configure uptime checks and automatic restarts if health checks fail.

### 8.2 Logging and error monitoring

- Send backend logs to a centralized provider (e.g. Datadog, Logflare, Papertrail)
- Alert on repeated 5xx API errors and contract invocation failures
- Monitor Redis errors and connection failures
- Monitor Supabase database errors and slow queries

### 8.3 Metrics to monitor

- API request rate and error rate
- Backend latency
- Redis memory usage and connection counts
- Database connection pool usage
- Stellar transaction failure rate
- Contract invocation latency

### 8.4 Alerting

Set alerts for:

- Backend service down or unhealthy
- `REDIS_URL` or database connectivity errors
- Spike in API 500 responses
- Contract initialization failures
- Unexpected drops in booking or listing traffic

### 8.5 Platform-specific monitoring

- Vercel: use deployment notifications and uptime checks
- Supabase: use database metrics, query performance charts, and alerts
- Redis provider: configure memory, CPU, and eviction alerts

---

## 9. Validation Steps

To confirm this assignment is complete, verify:

1. The file `DEPLOYMENT.md` exists at the repository root.
2. `DEPLOYMENT.md` documents Stellar testnet setup, backend deployment, frontend deployment, mainnet checklist, rollback procedures, and monitoring.
3. `task99.md` has been deleted from the repository.
4. The guide references the repository’s backend and frontend configuration patterns.

If all four checks are satisfied, the deployment documentation task is complete.
