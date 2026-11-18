# Rentars Release Procedure

This document is the authoritative reference for every production release of the Rentars platform.  Follow it in order.  Do not skip sections for payment, contract, or schema changes.

**Related documents**
- `DEPLOYMENT.md` — environment setup and low-level deployment commands
- `docs/releases/compatibility.md` — ABI and schema compatibility rules
- `docs/releases/rollback.md` — health gates, rollback ownership, and rehearsal
- `docs/releases/health-gates.json` — numeric thresholds for automated gate evaluation
- `docs/LAUNCH_READINESS_PROCEDURE.md` — full readiness record process for major releases

---

## 1. Approver matrix

Every release requires sign-off from the roles below before the production deploy begins.

| Scope | Required approver role | GitHub team |
|---|---|---|
| Any release | Release manager | @rentars/release |
| Backend service change | Functional lead | @rentars/engineering |
| Database migration | Functional lead + Platform lead | @rentars/engineering, @rentars/platform |
| Soroban contract deploy or upgrade | Blockchain lead | @rentars/contracts |
| Payment flow change (escrow, payout, refund) | Payments lead + Release manager | @rentars/payments, @rentars/release |
| Authentication / authorisation / RLS change | Security lead | @rentars/security |
| Frontend-only change | Functional lead | @rentars/engineering |

**Approval quorum for production payment or contract changes: 2 approvers minimum, one of whom must be the release manager.**

Sign-off is recorded as a GitHub PR review approval on the release PR, with a comment citing the relevant section of this document.

---

## 2. Release record — required fields

Before any artifact is deployed, create a release record by filling in the table below and committing it to `docs/releases/RELEASE_RECORD_<version>_<YYYY-MM-DD>.md`.

```
| Field                        | Value                                       |
|------------------------------|---------------------------------------------|
| Release version              | vX.Y.Z                                      |
| Release candidate tag        | vX.Y.Z-rc1 @ <full commit SHA>              |
| Release manager              | @github-handle                              |
| Planned production time      | YYYY-MM-DDTHH:MMZ                           |
| Monitoring window end        | YYYY-MM-DDTHH:MMZ  (minimum 2 h after go-live) |
| Monitoring owner             | @github-handle (must be online for the window) |
| Latest applied migration     | NNNNN_<name>.sql  (or "none" if no schema change) |
| New migrations in this release | List or "none"                            |
| Contract manifest path       | docs/releases/manifest-X.Y.Z.json  or "none" |
| Contracts deployed/upgraded  | List contract names and new IDs, or "none" |
| Rollback procedure           | Link to rollback.md § or inline notes       |
| Sign-offs                    | @handle (role) — YYYY-MM-DD                 |
```

The monitoring owner must remain reachable (chat + on-call phone) for the entire monitoring window.

---

## 3. Version and dependency compatibility

### 3.1 Backend ↔ database

| Check | How to verify |
|---|---|
| All migrations in `database/migrations/` are listed in `database/migrations.lock.json` | `bun run validate-migrations` |
| New migrations are additive — no column drops or type changes without a compatibility migration preceding them | Manual review; see `docs/releases/compatibility.md` |
| Staging database has all migrations applied before the backend deploy | `bun run db:status --env staging` |

### 3.2 Contract ABI

| Check | How to verify |
|---|---|
| `docs/releases/manifest-<version>.json` generated and committed | `bun run release:manifest --version <version>` |
| `CONTRACT_OVERVIEW.md` updated to reflect any new entry points, parameter changes, or TTL changes | Manual review |
| Existing on-chain data (live bookings, escrow IDs) compatible with the new contract version | Blockchain lead sign-off in PR |
| Backend `BOOKING_CONTRACT_ID` / `PROPERTY_LISTING_CONTRACT_ID` env vars updated if contracts are redeployed | Deployment checklist |

### 3.3 Frontend ↔ backend API

| Check | How to verify |
|---|---|
| No breaking API changes (renamed fields, removed endpoints) without a version bump | Contract tests: `bun run test:contract` |
| `NEXT_PUBLIC_API_URL` and other frontend env vars correct for the target environment | Vercel / env config review |

---

## 4. Pre-deployment checklist

Complete every item before triggering the production deploy.

- [ ] Release record created and committed (section 2)
- [ ] All required approvals collected (section 1)
- [ ] `bun run validate-migrations` passes on the release branch
- [ ] `bun run test:contract` passes against the staging API
- [ ] CI pipeline green: all jobs in `ci.yml` pass on the release tag
- [ ] Staging smoke tests complete (section 5) with evidence recorded
- [ ] Rollback plan reviewed and rehearsed in staging (section 6)
- [ ] Monitoring owner confirmed and reachable
- [ ] On-call engineer briefed on what changed and what to watch

---

## 5. Smoke-test checklist

Run these tests against the **production environment** immediately after the deploy completes, using dedicated test accounts that do not affect real data.

Record the actual observed output for each check in the release record.

### 5.1 Authentication and identity

| # | Test | Expected result |
|---|---|---|
| 1 | Log in with a test account via email/password | Successful session, redirects to dashboard |
| 2 | Attempt to access `/api/v1/bookings` without a session token | HTTP 401 |
| 3 | Log out | Session cleared; subsequent request returns 401 |

### 5.2 Public search and listing

| # | Test | Expected result |
|---|---|---|
| 4 | `GET /api/v1/properties?limit=1` | HTTP 200, JSON array with ≥1 property |
| 5 | Search with city filter from the frontend | Results render; no console errors |
| 6 | Open a property detail page | Page loads; images, price, and availability calendar render |

### 5.3 Booking availability

| # | Test | Expected result |
|---|---|---|
| 7 | `GET /api/v1/properties/:id/availability?check_in=…&check_out=…` for a known-available test property | `is_available: true`, valid nightly breakdown |
| 8 | Same endpoint for a date range known to be blocked | `is_available: false` |

### 5.4 Booking creation

| # | Test | Expected result |
|---|---|---|
| 9 | Submit a booking for the test property with a valid future date range | HTTP 201, booking status `Pending`, escrow ID present |
| 10 | Submit the same request again with the same `Idempotency-Key` header | HTTP 200 or 201, same booking ID returned (idempotent replay) |
| 11 | Submit a booking with an `Idempotency-Key` that was used with different payload | HTTP 422 |

### 5.5 Payment and escrow status

| # | Test | Expected result |
|---|---|---|
| 12 | `GET /api/v1/bookings/:id` for the test booking created in step 9 | Booking returned with correct status and escrow ID |
| 13 | `GET /api/v1/bookings/idempotency-status` with the key from step 9 | `{ status: "completed", booking: { … } }` |
| 14 | Cancel the test booking | Status transitions to `Cancelled`; refund policy applied |

### 5.6 Notifications

| # | Test | Expected result |
|---|---|---|
| 15 | Complete step 9; check notifications for the test tenant account | A `booking_created` in-app notification exists |
| 16 | Update a material property field (e.g. `check_in_time`) on a test property that has a confirmed booking | A `property_updated` notification appears for the test tenant |
| 17 | Update only a cosmetic field (e.g. `description`) on the same property | No new `property_updated` notification |

### 5.7 Health endpoints

| # | Test | Expected result |
|---|---|---|
| 18 | `GET /health` | HTTP 200, `{ status: "ok" }` |
| 19 | `GET /health/deep` | HTTP 200, all dependencies `connected` |

### 5.8 Offline resilience (frontend only)

| # | Test | Expected result |
|---|---|---|
| 20 | Open the booking form, disable network in DevTools, attempt to submit | Offline message shown; no fetch fired; form draft saved |
| 21 | Re-enable network; observe the status-lookup request | App queries `/api/v1/bookings/idempotency-status`, does not re-POST |
| 22 | With a fresh session, navigate to a property page while offline | Cached property data shown with stale indicator; booking CTA disabled |

---

## 6. Rollback and fix-forward criteria

### 6.1 Automatic rollback triggers (health gates)

The thresholds below match `docs/releases/health-gates.json`.  When any gate breaches, the on-call engineer must act within the specified time.

| Gate | Threshold | Action |
|---|---|---|
| HTTP 5xx error rate | > 5% for 2 consecutive 1-minute windows | **Pause rollout** |
| p99 API latency | > 3 000 ms for 2 consecutive windows | **Pause rollout** |
| Transaction failure ratio | > 2% for 1 window | **Rollback** — notify finance |
| Contract invocation failure ratio | > 5% for 1 window | **Rollback** — notify finance |
| Booking creation error rate | > 10% for 2 windows | **Pause rollout** |

### 6.2 Manual rollback decision

The release manager may declare a rollback at any time during the monitoring window.  Production rollbacks require two approvers (see section 1).

### 6.3 Rollback constraints

| Component | Reversible? | Notes |
|---|---|---|
| Backend service | Yes | Re-deploy the previous Docker image or git tag |
| Database migrations | No — once applied, they persist | Only additive migrations are allowed; write a compensating migration if needed |
| Soroban contracts | No — deployed WASM is immutable | Contract upgrades require the upgrade entry point; check `CONTRACT_UPGRADE_STRATEGY.md` |
| Frontend | Yes | Re-deploy the previous Vercel deployment |

### 6.4 Fix-forward conditions

A fix-forward (patch release instead of rollback) is acceptable when:
- The issue is isolated to a single non-critical endpoint.
- No financial data is at risk.
- A patch can be tested and deployed within the monitoring window.
- The release manager and at least one additional approver agree.

Document the fix-forward decision in the release record with a brief root-cause note.

---

## 7. Post-release monitoring window

The monitoring owner must stay online for at least **2 hours** after the production deploy.  During that window:

1. Watch the error rate and latency dashboards (`docs/SLO.md` dashboard links).
2. Run the health-gate evaluator every 5 minutes:
   ```bash
   bun run scripts/release-health-gate.ts --metrics metrics-snapshot.json
   ```
3. Check the notification outbox for processing backlogs:
   ```bash
   # Count of outbox rows not yet delivered
   psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM notification_outbox WHERE processed_at IS NULL;"
   ```
4. Verify no unexpected contract invocation errors in the Stellar RPC logs.
5. Record the final gate status in the release record under "Monitoring outcome".

If all gates are green at window end, mark the release as **complete** in the release record and notify the team.

---

## 8. Incident escalation

If a gate breaches or a smoke-test fails:

1. Post in `#incidents` with: release version, gate/test name, observed value, time.
2. Release manager decides pause vs. rollback within 15 minutes.
3. Create an incident record from `docs/INCIDENT_REVIEW_TEMPLATE.md`.
4. Do not close the monitoring window until the incident is resolved or the rollback is confirmed complete.
