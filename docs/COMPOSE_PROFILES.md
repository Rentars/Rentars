# Docker Compose Profiles

This document names the supported Compose commands, the services each starts,
the ports they bind, the environment files they expect, and how to verify
connectivity after startup.

---

## Supported profiles

| Profile | Command | Services | Ports |
|---|---|---|---|
| **Full-stack dev** | `docker compose up` (repo root) | web, api, redis | 3001, 3000, 6379 |
| **Backend dev only** | `docker compose up` (apps/backend) | api, redis | 3000, 6379 |
| **Frontend dev only** | `docker compose up` (apps/web) | web | 3001 |
| **Backend prod-like** | `docker compose -f apps/backend/docker-compose.prod.yml up -d` | api, redis | 3000 (redis internal only) |
| **Full staging stack** | `docker compose -f infra/docker-compose.staging.yml up -d` | nginx, api, web, redis | 80, 443 |

---

## Profile details

### Full-stack dev (recommended for most development)

**Command (from repo root):**

```bash
# First run: copy and populate both env files
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local

# Start all services with hot-reload
docker compose up
```

**Files applied** (Compose merges them in order):

1. `docker-compose.yml` — base service definitions with health checks
2. `docker-compose.override.yml` — dev overrides (source mounts, watch commands, debug port)

**Services and ports:**

| Service | Host port | Container port | Health check URL |
|---|---|---|---|
| api (Bun/Express) | 3000 | 3000 | `http://localhost:3000/health` |
| web (Next.js) | 3001 | 3001 | `http://localhost:3001/` |
| redis | 6379 | 6379 | `redis-cli ping` → `PONG` |

**Dependency order:** redis must be `healthy` before api starts; api must be `healthy` before web starts. A failed dependency produces a clear `service_healthy` failure rather than a misleading healthy result.

**Verify after startup:**

```bash
# All services healthy
docker compose ps

# API connectivity
curl -s http://localhost:3000/health | jq .
# Expected: {"status":"ok","checks":{"database":"...","cache":"..."}}

# Web-to-API connectivity (web proxies /api/* to the api service internally)
curl -s http://localhost:3001/api/v1/properties?limit=1

# Redis connectivity
docker compose exec redis redis-cli ping
# Expected: PONG
```

---

### Backend dev only

For backend work when you don't need the frontend.

**Command (from `apps/backend/`):**

```bash
cp .env.example .env
# Edit .env
docker compose up
```

**File:** `apps/backend/docker-compose.yml`

**Services and ports:**

| Service | Host port | Health check |
|---|---|---|
| api | 3000 | `GET http://localhost:3000/health` |
| redis | 6379 | `redis-cli ping` |

**Verify:**

```bash
curl -s http://localhost:3000/health | jq .
docker compose exec redis redis-cli ping
```

---

### Frontend dev only

For frontend-only work, pointing at an external or already-running backend.

**Command (from `apps/web/`):**

```bash
cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:3000 (or your backend URL)
docker compose up
```

**File:** `apps/web/docker-compose.yml`

**Services and ports:**

| Service | Host port | Health check |
|---|---|---|
| web | 3001 | `GET http://localhost:3001/` |

---

### Backend prod-like

Runs the built Docker image with production settings (no source mounts, Redis
not exposed to the host, log rotation). Useful for validating the production
image locally before pushing.

**Command (from `apps/backend/`):**

```bash
cp .env.production.example .env.production
# Edit .env.production — fill all required values
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

**File:** `apps/backend/docker-compose.prod.yml`

**Services and ports:**

| Service | Host port | Notes |
|---|---|---|
| api | 3000 | Bound to host for direct testing |
| redis | (none) | Internal only — not reachable from host |

**Verify:**

```bash
docker compose -f docker-compose.prod.yml ps
curl -s http://localhost:3000/health | jq .
```

---

### Full staging stack

The authoritative staging environment — nginx TLS termination, password-
protected Redis, all services on an internal network.

**Command (from repo root):**

```bash
cp infra/environments/staging/.env.staging.example \
   infra/environments/staging/.env.staging
# Edit .env.staging — all SECRET_* vars required

docker compose -f infra/docker-compose.staging.yml \
  --env-file infra/environments/staging/.env.staging \
  up -d
```

**File:** `infra/docker-compose.staging.yml`

**Services and ports:**

| Service | Host port | Notes |
|---|---|---|
| nginx | 80, 443 | TLS termination; routes /api/* → api, /* → web |
| api | (internal only) | Reachable via nginx |
| web | (internal only) | Reachable via nginx |
| redis | (internal only) | Password-protected |

**Verify:**

```bash
docker compose -f infra/docker-compose.staging.yml ps
curl -s https://staging.rentars.app/health | jq .
```

---

## Health check behaviour

Every service in every profile has an explicit `healthcheck`. Compose uses
these to gate startup ordering via `depends_on: condition: service_healthy`.

**What this means in practice:**

- If Redis fails to start, `api` will show `Waiting` state — not healthy. You
  get a clear signal rather than an api container that starts and immediately
  crashes with a Redis connection error.
- If `api` fails its health check, `web` stays in `Waiting` state — preventing
  a frontend that silently fails all API calls.

**Health check parameters (all profiles):**

| Service | Interval | Timeout | Retries | Start period |
|---|---|---|---|---|
| api | 30s | 10s | 3 | 20–30s |
| web | 30s | 10s | 3 | 40–90s (dev) / 25s (staging) |
| redis | 10s | 5s | 5 | 5s |
| nginx | 30s | 5s | 3 | 5s |

---

## Environment files

| Profile | Expected file(s) |
|---|---|
| Full-stack dev | `apps/backend/.env`, `apps/web/.env.local` |
| Backend dev | `apps/backend/.env` |
| Frontend dev | `apps/web/.env.local` |
| Backend prod-like | `apps/backend/.env.production` |
| Staging | `infra/environments/staging/.env.staging` |

**Never commit `.env`, `.env.local`, `.env.production`, or `.env.staging`.**
All are listed in `.gitignore`. Use the `.example` templates as the source of
truth for required variables.

---

## Troubleshooting

**Service stuck in `health: starting`:**

```bash
# See the actual health check output
docker inspect --format='{{json .State.Health}}' <container_name> | jq .
```

**api fails to start (exit 1 immediately):**

```bash
docker compose logs api
# Look for "Fatal startup error" — usually a missing or invalid env var.
# env.ts logs exactly which variable failed Zod validation.
```

**redis not reachable from api:**

```bash
# Verify they share a network
docker network inspect rentars
# Verify redis is healthy
docker compose exec redis redis-cli ping
```

**Port already in use:**

```bash
# Find the conflicting process
netstat -ano | findstr :3000
# Then either stop it or change the host port in the override file
```
