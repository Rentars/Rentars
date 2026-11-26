# Rentars

![Backend CI](https://github.com/Rentars/Rentars/actions/workflows/backend-ci.yml/badge.svg)
![Frontend CI](https://github.com/Rentars/Rentars/actions/workflows/frontend-ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/Rentars/Rentars/graph/badge.svg)](https://codecov.io/gh/Rentars/Rentars)

> Decentralized peer-to-peer rental platform built on the [Stellar](https://stellar.org) blockchain.

Rentars is an evolution of [StellarRent](https://github.com/Stellar-Rent/stellar-rent), rebranded and substantially extended. The mission is the same: eliminate rental intermediaries (Airbnb, agencies) through Stellar's fast transactions (~3–5 s), near-zero fees (~$0.000001), and Soroban smart contracts for trustless escrow — but the platform is now a fully featured system, not a scaffold.

---

## Why Rentars?

Traditional rental platforms charge 7–20 % in fees, take 1–7 days to process payments, and exclude small property owners in emerging markets. Rentars addresses this with:

- **Minimal fees** — Stellar's near-zero transaction costs passed directly to users
- **Instant USDC payments** — Payments settle in seconds, not days
- **Trustless escrow** — Soroban smart contracts hold funds until rental conditions are met
- **Full transparency** — Every transaction recorded on Stellar's public ledger
- **No middlemen** — Direct owner-to-tenant relationships

---

## Implemented features

The following are implemented and tested in the current codebase.
"Code-complete" means the feature has automated tests and runs in the CI pipeline.
It does **not** imply deployment-verified or mainnet-ready status — those require the
additional steps in [`DEPLOYMENT.md`](DEPLOYMENT.md) and are tracked separately in
[Deployment-verified capabilities](#deployment-verified-capabilities) below.

### Backend (Node.js / Bun / Express)

| Feature | Status |
|---|---|
| User registration & login (email + password) | ✅ Implemented |
| JWT authentication + refresh tokens | ✅ Implemented |
| Passkey / WebAuthn authentication | ✅ Implemented |
| Freighter wallet authentication (Stellar) | ✅ Implemented |
| Email verification + password reset | ✅ Implemented |
| hCaptcha middleware | ✅ Implemented |
| Role-based access control (host / tenant / admin) | ✅ Implemented |
| Property CRUD with image upload (Supabase Storage) | ✅ Implemented |
| Full-text property search (PostgreSQL GIN index) | ✅ Implemented |
| Geolocation radius search (PostGIS) | ✅ Implemented |
| Search autocomplete & trending searches | ✅ Implemented |
| Search analytics tracking | ✅ Implemented |
| Booking creation, confirmation, cancellation | ✅ Implemented |
| Booking dispute raise & resolution | ✅ Implemented |
| Availability calendar management | ✅ Implemented |
| Dynamic pricing | ✅ Implemented |
| USDC escrow via Trustless Work API | ✅ Implemented |
| Blockchain sync service (Soroban events → DB) | ✅ Implemented |
| Reviews & ratings | ✅ Implemented |
| Notifications (in-app + push) | ✅ Implemented |
| Wishlists | ✅ Implemented |
| Host dashboard & earnings analytics | ✅ Implemented |
| Messaging between host and tenant | ✅ Implemented |
| Redis caching layer | ✅ Implemented |
| Rate limiting (per-route + per-user) | ✅ Implemented |
| Structured logging + Prometheus metrics | ✅ Implemented |
| Admin panel (property moderation, user management) | ✅ Implemented |

### Frontend (Next.js 16)

| Feature | Status |
|---|---|
| Property listing pages with image gallery | ✅ Implemented |
| Advanced search with filters and map view | ✅ Implemented |
| Booking flow with availability calendar | ✅ Implemented |
| Wallet connection (Freighter) + onboarding modal | ✅ Implemented |
| Escrow status tracking UI | ✅ Implemented |
| Host dashboard with calendar management | ✅ Implemented |
| Tenant dashboard with booking history | ✅ Implemented |
| Notification centre | ✅ Implemented |
| Profile management | ✅ Implemented |
| Dark / light theme | ✅ Implemented |
| Offline support (service worker + offline banner) | ✅ Implemented |
| i18n internationalisation scaffolding | ✅ Implemented |
| Responsive design (mobile + desktop) | ✅ Implemented |

### Smart Contracts (Rust / Soroban)

| Contract | Status |
|---|---|
| Property listing contract | ✅ Implemented |
| Booking contract (with escrow lifecycle) | ✅ Implemented |
| Review contract | ✅ Implemented |

### Deployment-verified capabilities

Code-complete is not the same as deployment-verified. The table below records what has
actually been exercised against a live environment. Anything not listed here should be
treated as **unverified in production**.

| Capability | Status | Notes |
|---|---|---|
| Local development stack (backend + frontend + Redis) | ✅ Verified | Documented commands in this README |
| CI pipeline (lint, typecheck, unit/integration tests, build) | ✅ Verified | GitHub Actions on `main` |
| Staging / testnet deployment | ⚠️ Partially verified | Follow [`DEPLOYMENT.md`](DEPLOYMENT.md); verify each step |
| Mainnet deployment | ❌ Not performed | Gated — see [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Smart contract security audit | ❌ Not performed | Contracts are unaudited |
| Production load / capacity validation | ❌ Not verified | See [`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md) |

### Known limitations

- Mainnet deployment has not been performed. The system targets Stellar testnet.
- Smart contracts have not undergone a third-party security audit.
- Geocoding (latitude/longitude import) requires a configured `GEOCODING_API_KEY`.
- PostGIS must be enabled on the Supabase project before geolocation search works.
- The Stellar CLI and Rust toolchain are required only to build / redeploy contracts, not to run the application.

---

## Monorepo structure

```
rentars/
├── apps/
│   ├── web/                        # Next.js 16 frontend (TypeScript + Tailwind CSS)
│   │   ├── src/
│   │   │   ├── app/                # Next.js App Router pages
│   │   │   ├── components/         # UI components (booking, search, dashboard, …)
│   │   │   ├── hooks/              # React hooks (useProperties, useBookingActions, …)
│   │   │   ├── services/           # API client helpers
│   │   │   ├── context/            # WalletContext
│   │   │   ├── lib/                # Stellar utils, i18n, error handling
│   │   │   └── types/              # Shared TypeScript types
│   │   ├── e2e/                    # Playwright end-to-end tests
│   │   └── package.json
│   │
│   ├── backend/                    # Bun/Node.js Express API
│   │   ├── src/
│   │   │   ├── controllers/        # Request handlers (30+ controllers)
│   │   │   ├── services/           # Business logic (40+ services)
│   │   │   ├── middleware/         # Auth, rate limiting, metrics, CORS, …
│   │   │   ├── routes/             # Express route definitions
│   │   │   ├── blockchain/         # Soroban client wrappers
│   │   │   ├── validators/         # Zod request validators
│   │   │   └── config/             # Supabase, Redis, env config
│   │   ├── database/
│   │   │   └── migrations/         # 100+ SQL migration files
│   │   └── package.json
│   │
│   └── contracts/                  # Soroban smart contracts (Rust)
│       ├── contracts/
│       │   ├── booking/
│       │   ├── property-listing/
│       │   └── review-contract/
│       └── Cargo.toml
│
├── docs/                           # Architecture, capacity planning, incident review
├── tests/                          # Performance test scripts (K6)
├── ARCHITECTURE.md                 # Detailed system design
├── DEPLOYMENT.md                   # Testnet and mainnet deployment guide
├── docs/CAPABILITY_MATRIX.md       # Feature status: code vs. testnet vs. production
├── biome.json                      # Linting & formatting config
├── turbo.json                      # Turborepo build pipeline
└── package.json                    # Monorepo root (Yarn workspaces)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, TypeScript |
| Backend | Node.js / Bun runtime, Express 5, TypeScript |
| Database | Supabase (PostgreSQL + Auth + Storage + RLS) |
| Cache | Redis 7 |
| Smart Contracts | Rust, Soroban SDK |
| Blockchain | Stellar (testnet; mainnet-ready) |
| Payments | USDC via Stellar + Trustless Work escrow API |
| Wallet | Freighter API |
| Testing | Bun test (backend), Vitest (frontend unit), Playwright (E2E) |
| Linting | Biome |
| CI | GitHub Actions |

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| [Bun](https://bun.sh) | 1.1.38 (pinned) | Backend dev and test |
| [Node.js](https://nodejs.org) | 20.18.0 (pinned) | Frontend and tooling |
| [Yarn](https://yarnpkg.com) | ≥ 1.22 | Workspace management |
| [Docker](https://www.docker.com) | ≥ 24 | Full-stack local dev, RLS tests |
| [Supabase account](https://supabase.com) | — | Database and auth |
| [Rust + Cargo](https://rustup.rs) | stable (1.82.0 in CI) | Contracts only |
| `wasm32-unknown-unknown` Rust target | — | Contracts only |
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) | — | Contracts only |

---

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/Rentars/Rentars.git
cd Rentars
yarn install
```

### 2. Configure environment

```bash
# Backend
cp apps/backend/.env.example apps/backend/.env
# Edit apps/backend/.env and fill in:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   JWT_SECRET (openssl rand -hex 32)
#   REDIS_URL=redis://localhost:6379
#   TRUSTLESS_WORK_API_URL, TRUSTLESS_WORK_API_KEY
#   STELLAR_NETWORK=testnet
#   STELLAR_RPC_URL=https://soroban-testnet.stellar.org
#   PROPERTY_LISTING_CONTRACT_ID, BOOKING_CONTRACT_ID

# Frontend
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local and fill in:
#   NEXT_PUBLIC_API_URL=http://localhost:3000
#   NEXT_PUBLIC_STELLAR_NETWORK=testnet
#   NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

See `apps/backend/.env.example` and `apps/web/.env.example` for all available variables
with descriptions.

### 3. Run the development stack

Option A — individual services (from the repo root):

```bash
# Terminal 1: backend (port 3000)
yarn workspace rentars-backend dev

# Terminal 2: frontend (port 3001, per apps/web next.config)
yarn workspace rentars-web dev
```

Option B — full Docker stack (backend + frontend + Redis):

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3001 |
| Backend API | http://localhost:3000 |
| API health | http://localhost:3000/health |
| Redis | redis://localhost:6379 |

### 4. Apply database migrations

The backend database schema is managed with SQL migration files under
`apps/backend/database/migrations/`. The authoritative bootstrap entrypoint is
`apps/backend/database/setup.sql`, which applies the schema and migrations in order.
Apply it to your Supabase project with `psql` (this is the same path CI uses):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/backend/database/setup.sql
```

`DATABASE_URL` must point at your Supabase Postgres instance (use the connection
string from the Supabase dashboard; never commit it). See [`DEPLOYMENT.md`](DEPLOYMENT.md)
for the complete migration procedure, rollback steps, and verification queries.

---

## Running tests

All commands below are run from the repo root and use the workspace package scripts.

### Backend

```bash
# All tests
yarn workspace rentars-backend test

# Unit tests only
yarn workspace rentars-backend test:unit

# Integration tests
yarn workspace rentars-backend test:integration

# RLS policy tests
yarn workspace rentars-backend test:rls
```

### Frontend

```bash
# Unit and component tests (Vitest)
yarn workspace rentars-web test --run

# End-to-end tests (Playwright — requires a running dev server)
yarn workspace rentars-web e2e

# Visual regression baselines — capture new snapshots
yarn workspace rentars-web exec playwright test e2e/visual-regression.spec.ts --update-snapshots
```

### Contracts

```bash
# Build all Soroban contracts (requires Rust + wasm32-unknown-unknown)
yarn workspace rentars-contracts build
```

---

## API overview

All endpoints are prefixed with `/api/v1`. The full OpenAPI spec is at
`apps/backend/openapi.json`.

| Route group | Example endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/wallet` |
| Properties | `GET /properties`, `GET /properties/:id`, `POST /properties` |
| Search | `GET /properties/search/advanced`, `GET /properties/search/suggestions` |
| Bookings | `POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/dispute` |
| Reviews | `GET /properties/:id/reviews`, `POST /reviews` |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read` |
| Host | `GET /host/dashboard`, `GET /host/earnings` |
| Wallet | `GET /wallet/connect`, `POST /wallet/auth` |
| Admin | `GET /admin/properties`, `PATCH /admin/users/:id` |
| Health | `GET /health` (liveness), `GET /health/ready` (readiness) |

---

## CI/CD

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | Push / PR to `main`, `develop` | Lint · type-check · backend unit · backend E2E · RLS · contracts · frontend unit · frontend E2E · docs link check · restore drill |
| `security-scan.yml` | Push to `main` + nightly | Gitleaks · yarn/bun/cargo audit · Trivy container scan |
| `infra-plan.yml` | PR touching `infra/` | Terraform plan · Docker image scan |
| `smoke-tests.yml` | Manual / post-deploy | Playwright smoke on target environment |

---

## Documentation

| Document | Purpose |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System design, data flows, DB schema, caching |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Testnet and mainnet deployment, rollback, monitoring |
| [`apps/backend/RUNBOOKS.md`](apps/backend/RUNBOOKS.md) | On-call incident response procedures |
| [`docs/INCIDENT_REVIEW_TEMPLATE.md`](docs/INCIDENT_REVIEW_TEMPLATE.md) | Post-incident review template |
| [`docs/RECOVERY_RUNBOOK.md`](docs/RECOVERY_RUNBOOK.md) | Cross-component recovery: DB, storage, Redis, contracts, RPC, email, frontend; monthly drill |
| [`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md) | Throughput targets, benchmarking, scaling triggers |
| [`docs/SEARCH.md`](docs/SEARCH.md) | Full-text, geolocation, autocomplete, and analytics search guide |
| [`docs/WALLET.md`](docs/WALLET.md) | Freighter wallet connection, passkey, and onboarding guide |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add property search"`
4. Open a pull request against `main`

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full setup guide, test isolation rules,
and CI job reference.

This project is inspired by [StellarRent](https://github.com/Stellar-Rent/stellar-rent),
built with the [OnlyDust](https://app.onlydust.com) community.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE)

---

## Acknowledgements

- [StellarRent](https://github.com/Stellar-Rent/stellar-rent) — the original open-source project this is based on
- [Stellar Development Foundation](https://stellar.org) — for Soroban and the Stellar network
- [OnlyDust](https://app.onlydust.com) — open-source contributor community
- [Supabase](https://supabase.com) — backend-as-a-service
- [Trustless Work](https://trustlesswork.com) — escrow API
