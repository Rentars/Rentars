# Rentars Roadmap

This document is the single source of truth for planned and in-progress work.
It is updated at the end of every quarterly review (see [Quarterly Review Process](#quarterly-review-process)).

---

## Label definitions

| Label | Meaning |
|---|---|
| `P0` | Production outage or data loss — stop everything |
| `P1` | Major feature broken or launch blocker — current sprint |
| `P2` | Meaningful improvement — scheduled milestone |
| `P3` | Nice-to-have — backlog |
| `launch-blocker` | Must be resolved before any production release |
| `launch-risk` | Release can proceed, but risk owner must sign off |
| `triage` | Newly filed, not yet assessed |
| `stale` | No activity for 90 days; will be closed in 14 days unless updated |

---

## Current sprint blockers

> These issues must be resolved before the next production deployment.
> Each must have: owner, deadline, and a mitigation plan if it slips.

| # | Title | Owner | Due | Risk if slips |
|---|---|---|---|---|
| 112 | Dispute resolution — frontend components (DisputeButton, DisputeModal) | *unassigned* | — | Tenants cannot raise disputes from the UI; only via API |
| — | PostGIS migration deployment (`00014_search_analytics_and_geolocation.sql`) | *unassigned* | — | Geolocation search silently degrades; analytics table missing |
| — | Mainnet contract audit | *unassigned* | — | Cannot move to mainnet without third-party audit sign-off |

---

## Q4 2026 milestone — Mainnet readiness

**Goal:** Platform is production-ready for mainnet launch with real USDC.

### Functional
- [ ] #112 Dispute resolution UI (DisputeButton + DisputeModal)
- [ ] End-to-end mainnet USDC escrow flow validated on Stellar mainnet
- [ ] PostGIS geolocation migration applied and geospatial search confirmed working
- [ ] Exchange rate stale-rate UI warning surfaced to users (see I18N_CURRENCY_POLICY.md)

### Security & contracts
- [ ] Third-party Soroban contract audit (Property, Booking, Review contracts)
- [ ] Admin key rotation procedure documented and tested
- [ ] Supabase RLS policies re-verified against audit findings

### Reliability
- [ ] Uptime monitoring configured (health endpoint + alerting)
- [ ] On-call runbook reviewed and owners assigned (see apps/backend/RUNBOOKS.md)
- [ ] Database backup verified — restore drill completed
- [ ] Redis failure fallback tested (exchange rates, caching)

### Privacy & compliance
- [ ] Analytics opt-out flow implemented (see docs/ANALYTICS_TAXONOMY.md)
- [ ] Analytics retention policy enforced via scheduled purge
- [ ] GDPR/data-subject-request process documented

### Launch gating
- [ ] LAUNCH_READINESS.md sign-offs complete for all blocking areas

---

## Q1 2027 milestone — Growth features

- [ ] Multi-currency display improvements (exchange rate timestamp shown to users)
- [ ] RTL layout support (Arabic, Hebrew)
- [ ] Dispute resolution — admin mediation dashboard
- [ ] Saved searches notifications ("new properties matching your search")
- [ ] Mobile PWA install prompt improvements
- [ ] Performance budget CI gate (Lighthouse scores)

---

## Backlog (unscheduled)

Items below are accepted but not yet scheduled. They need owner, estimate, and milestone before work begins.

| Area | Title | Priority | Notes |
|---|---|---|---|
| i18n | Additional locale support (ar, de, ko, tr) | P3 | Needs translation ownership defined first |
| Analytics | Funnel dashboard for search → booking conversion | P2 | Blocked on analytics taxonomy migration |
| Auth | Passkey recovery flow (lost device) | P2 | |
| Payments | Receipt PDF localisation (date/currency formatting) | P2 | |
| Reviews | Bulk review moderation admin UI | P3 | |
| Search | Saved search alert emails | P3 | `savedSearch.service.ts` already implemented |
| Blockchain | Stellar mainnet monitoring/alerting | P1 | Needed before mainnet |
| Infra | Automated database migration CI job | P2 | Currently manual |
| Infra | Dependency update automation (Dependabot or Renovate) | P3 | |
| DX | Contract test coverage for all Soroban functions | P2 | |

---

## Recently completed

| Completed | Title | PR / commit |
|---|---|---|
| 2026-07-27 | BookingForm edge-case test suite (15 cases) | — |
| 2026-07-27 | Request timeout middleware (504 + AbortSignal) | — |
| 2026-07-27 | Stable error codes + frontend error mapping (25+ codes) | — |
| 2026-07-27 | Dark mode audit and fix (12 components) | — |
| — | Advanced property search (full-text + PostGIS + analytics) | — |
| — | Dispute resolution backend (raise/resolve endpoints + notifications) | — |
| — | Exchange rate service with background refresh loop | — |
| — | Notification preferences + push subscriptions | — |
| — | Dynamic pricing (seasonal rates, special events) | — |
| — | Email verification + password reset | — |

---

## Quarterly review process

Reviews happen the **last week of each quarter** (March, June, September, December).

### Agenda
1. Review all open P0/P1/launch-blocker issues — confirm owners and deadlines.
2. Close or update all issues labelled `stale`.
3. Close issues where work is confirmed complete — add reference to PR or commit.
4. Move unscheduled backlog items to the next milestone or explicitly defer.
5. Publish a dated entry in CHANGELOG.md summarising the roadmap update.
6. Update the "Q_N YYYY milestone" section above with the next quarter's goals.

### Stale-item policy
- Any open issue with no activity (comment, label change, commit reference) for **90 days** is labelled `stale`.
- If no update is made within 14 days of being labelled `stale`, the issue is closed with the note: *"Closed as stale. Reopen with updated context if this is still relevant."*
- Launch blockers are exempt from stale closure — they must be resolved or explicitly deferred by a maintainer.

### Dependency visibility
- All issues must declare `Blocks` and `Depends on` fields (see issue templates).
- The sprint blocker table above must be regenerated at the start of each sprint from issues labelled `launch-blocker`.

---

*Last updated: 2026-Q3 review — 2026-09-23*
