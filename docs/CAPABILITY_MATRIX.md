# Capability Matrix

This document records the current status of every core platform capability.
It is the authoritative answer to "is feature X ready for production?"

---

## Status labels

| Label | Meaning | Evidence required |
|---|---|---|
| ✅ **Code complete** | Implemented, passes unit/integration tests in CI | Passing CI job |
| 🧪 **Testnet verified** | End-to-end tested against Stellar testnet or staging Supabase | Manual or CI E2E run link |
| 🏗️ **Staging validated** | Deployed to staging environment and smoke-tested | Smoke test report |
| 🚫 **Not production-ready** | Missing audit, mainnet deployment, or sign-off | See notes |
| ⚠️ **Partial** | Core path works; edge cases or optional paths incomplete | Notes |
| ❌ **Not implemented** | Not yet built | — |

**Important:** "Code complete" means tests pass in CI against mocks.
It does not mean the feature works against mainnet infrastructure.
Do not equate source code with production validation.

---

## Identity and authentication

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Email + password registration | ✅ Code complete | `bun run test:unit` — `auth.service.test.ts` | — | — |
| JWT access + refresh tokens | ✅ Code complete | `authTokenHardening.test.ts` | — | — |
| Email verification | ✅ Code complete | `emailVerification.service.test.ts` | — | — |
| Password reset | ✅ Code complete | `passwordReset.service.test.ts` | — | — |
| Passkey / WebAuthn | ✅ Code complete | `src/__tests__/` passkey tests | — | Browser support varies; not tested on mobile |
| Freighter wallet auth (Stellar) | ✅ Code complete | `walletLinking.test.ts` | — | Testnet key only |
| Session revocation | ✅ Code complete | `sessionRevocation.test.ts` | — | — |
| Role-based access control | ✅ Code complete | `roleTransitions.test.ts` | — | — |
| hCaptcha bot protection | ✅ Code complete | `captcha.test.ts` | — | `HCAPTCHA_ENABLED=false` in test env |
| Rate limiting (auth endpoints) | ✅ Code complete | `authRateLimit.test.ts` | — | Production tuning needed |

---

## Listings

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Property CRUD | ✅ Code complete | `property.service.test.ts` | — | — |
| Image upload (Supabase Storage) | ✅ Code complete | `propertyImage.service.test.ts` | — | EXIF stripping verified |
| Draft / publish workflow | ✅ Code complete | `listing-drafts.test.ts` | — | — |
| Soft delete | ✅ Code complete | `softDelete.property.test.ts` | — | — |
| Property moderation (admin) | ✅ Code complete | `moderationPolicy.service.test.ts` | — | — |
| Full-text search (GIN index) | ✅ Code complete | `propertySearch.service.test.ts` | — | Requires `pg_trgm` extension |
| Geolocation radius search | ⚠️ Partial | `geolocationStatus.test.ts` | — | PostGIS must be manually enabled on Supabase project |
| Search autocomplete | ✅ Code complete | `searchSort.test.ts` | — | — |
| Search analytics | ✅ Code complete | `searchMetrics.test.ts` | — | — |
| Dynamic pricing | ✅ Code complete | `pricing.service.test.ts` | — | — |

---

## Booking

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Booking creation | ✅ Code complete | `booking.service.test.ts`, `booking-journey.test.ts` | — | — |
| Availability calendar | ✅ Code complete | `availability.service.test.ts` | — | — |
| Booking confirmation | ✅ Code complete | `booking-journey.test.ts` phase 5 | — | — |
| Booking cancellation + refund | ✅ Code complete | `booking-transitions.test.ts` | — | Refund tiers tested via property-based tests |
| Dispute raise / resolve | ✅ Code complete | `src/__tests__/` dispute tests | — | — |
| Idempotency (duplicate prevention) | ✅ Code complete | `idempotency.test.ts`, `idempotency-concurrent.test.ts` | — | — |
| Concurrency safety (atomic reserve) | ✅ Code complete | `concurrency.test.ts` (14 suites) | — | In-memory mock DB; not tested against live Postgres locks |
| ICS calendar download | ✅ Code complete | `booking-journey.test.ts` phase 7 | — | — |
| PDF receipt | ✅ Code complete | `booking-journey.test.ts` phase 7 | — | — |
| Guest count validation | ✅ Code complete | `booking-capacity-and-ics.test.ts` | — | — |
| House rules acknowledgement | ✅ Code complete | `duplicate-and-house-rules.test.ts` | — | — |

---

## Payments and escrow

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| USDC escrow creation (TrustlessWork) | ✅ Code complete | `booking.service.test.ts` escrow flow | — | Integration tested against TrustlessWork sandbox |
| Escrow release on completion | ✅ Code complete | `escrow-reconciliation-durability.test.ts` | — | — |
| Escrow cancel on booking cancel | ✅ Code complete | `booking.service.test.ts` | — | — |
| Payment retry with circuit breaker | ✅ Code complete | `payment-attempt-circuit.test.ts` | — | — |
| Exchange rate display | ✅ Code complete | `exchangeRate.service.test.ts` | — | Staleness warning implemented |
| Mainnet USDC escrow | 🚫 Not production-ready | — | — | Requires mainnet deployment; no audit |
| Receipt PDF with USDC amounts | ✅ Code complete | `receipt.test.ts` | — | — |

---

## Smart contracts

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Property listing contract (Rust/Soroban) | ✅ Code complete | `cargo test` — contracts CI job | — | WASM artifact uploaded per CI run |
| Booking contract with escrow lifecycle | ✅ Code complete | `cargo test` — contracts CI job | — | — |
| Review contract | ✅ Code complete | `cargo test` — contracts CI job | — | — |
| Testnet deployment | 🧪 Testnet verified | Manual — see DEPLOYMENT.md | — | Contract IDs in `.env.example` are placeholders |
| Mainnet deployment | 🚫 Not production-ready | — | — | No third-party audit; not deployed |
| Third-party security audit | 🚫 Not production-ready | — | — | Required before mainnet |

---

## Notifications

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| In-app notifications | ✅ Code complete | `notification.service.test.ts` | — | — |
| Email notifications (SMTP) | ✅ Code complete | `email.service.test.ts` | — | Requires SMTP credentials in production |
| Push notifications | ✅ Code complete | `push.service.test.ts` | — | — |
| Notification preferences | ✅ Code complete | `notification.enhancements.test.ts` | — | — |
| Booking reminder scheduler | ✅ Code complete | `reminder.test.ts` | — | — |

---

## Reviews

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Review submission | ✅ Code complete | `review.service.test.ts` | — | — |
| Review eligibility enforcement | ✅ Code complete | `review.service.test.ts` | — | DB trigger + service layer both enforced |
| Review moderation | ✅ Code complete | `review.moderation.enhanced.test.ts` | — | — |
| Rating aggregation | ✅ Code complete | `reviewSync.service.test.ts` | — | — |

---

## Operational controls

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Admin dashboard | ✅ Code complete | `admin.auditlogs.routes.test.ts` | — | — |
| Audit logging | ✅ Code complete | `auditLog.service.test.ts` | — | — |
| Data retention sweep | ✅ Code complete | `privacy.lifecycle.test.ts` | — | Dry-run fires 10s after startup |
| Redis cache | ✅ Code complete | `cache.service.test.ts` | — | Falls back gracefully if Redis unavailable |
| Prometheus metrics | ✅ Code complete | `metrics.middleware.test.ts` | — | `/metrics` requires `METRICS_TOKEN` in production |
| Liveness probe (`GET /health`) | ✅ Code complete | `health.test.ts` | — | Returns 200 without dependency checks |
| Readiness probe (`GET /health/ready`) | ✅ Code complete | `health.test.ts` | — | Checks DB + Redis + RPC |
| Backup restore drill | ✅ Code complete | `restore-drill` CI job | — | Runs in CI on every push; scheduled weekly |
| RLS policy coverage | ✅ Code complete | `rls-tests` CI job | — | Applies real migrations to Postgres in CI |

---

## Frontend / UX

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Property search UI with filters | ✅ Code complete | Playwright `search.spec.ts` | — | — |
| Property detail page | ✅ Code complete | Playwright `booking.spec.ts` | — | — |
| Booking flow | ✅ Code complete | Playwright `search-to-booking-journey.spec.ts` | — | — |
| Wallet connection (Freighter) | ✅ Code complete | Playwright `auth.spec.ts` | — | — |
| Host dashboard | ✅ Code complete | Vitest component tests | — | — |
| Tenant dashboard | ✅ Code complete | Vitest component tests | — | — |
| Dark / light theme | ✅ Code complete | Playwright visual regression | — | Baselines not yet committed (`.gitkeep` only) |
| i18n (en, es, fr, pt) | ⚠️ Partial | Vitest i18n tests | — | Scaffolding complete; translation strings not fully populated |
| Accessibility — automated axe | ✅ Code complete | `accessibility-audit` CI job (axe/Playwright) | — | Covers home, search, property, auth, booking, dashboard, dark mode |
| Accessibility — keyboard tests | ✅ Code complete | `keyboard-accessibility.test.tsx` | — | Covers SearchAutocomplete, FilterSidebar, PropertyCard |
| Accessibility — manual sign-off | 🚫 Not production-ready | `src/tests/a11y-manual-matrix.ts` | — | 0 / 36 checks signed off; required before launch |
| Offline support (service worker) | ✅ Code complete | — | — | Not independently tested in CI |
| Responsive design | ✅ Code complete | Playwright `mobile-chrome` project | — | — |

---

## Security posture

| Capability | Status | Evidence | Owner | Notes |
|---|---|---|---|---|
| Secret detection (Gitleaks) | ✅ Code complete | `security-scan.yml` | — | Runs on every push + nightly |
| Dependency audit (yarn + bun + cargo) | ✅ Code complete | `security-scan.yml` | — | Fails on high/critical CVEs |
| Container image scan (Trivy) | ✅ Code complete | `security-scan.yml` | — | HIGH + CRITICAL severity |
| CORS origin restriction | ✅ Code complete | `cors.middleware.test.ts`, `envProductionOrigins.test.ts` | — | Wildcard origins rejected |
| CSRF protection | ✅ Code complete | `csrf-protection.test.ts` | — | — |
| Input validation (Zod) | ✅ Code complete | `validators.test.ts` | — | — |
| Security headers (Helmet) | ✅ Code complete | `security-headers.test.ts` | — | — |

---

## How to update this matrix

1. When a feature moves to a new status, update the row with:
   - The new label
   - A link to the evidence (CI run URL, test command, or manual test report)
   - The date in the Notes column if the evidence expires

2. "Testnet verified" evidence must be a dated manual or CI run, not just source code.

3. This file is reviewed as part of release preparation — see `LAUNCH_READINESS.md`
   Section 1 (Functional) which references this matrix for F2–F9.

4. Owner: the team member who last updated the row is responsible for keeping it current.
   Assign ownership during release prep.

---

*Last updated: 2026-11-21*
*Reviewed by: (not yet assigned — assign during release prep)*
