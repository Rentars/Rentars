# Frontend Performance Budgets

This document records the published performance budgets for Rentars, how they are
enforced, and any documented exceptions.

---

## Why budgets matter

Maps, wallet libraries, Stellar SDK, property images, and dashboard charts make
initial load and interaction slow — especially on mobile networks. Explicit, version-
controlled budgets give reviewers a hard signal when a PR introduces a regression.

---

## Budgets

### Core Web Vitals (throttled mobile — mid-tier device, fast 4G)

| Metric | Budget | Policy |
|---|---|---|
| LCP (Largest Contentful Paint) | ≤ 2.5 s | Warn |
| INP proxy — TBT (Total Blocking Time) | ≤ 300 ms | Warn |
| CLS (Cumulative Layout Shift) | ≤ 0.10 | Warn |
| FCP (First Contentful Paint) | ≤ 1.8 s | Warn |
| Speed Index | ≤ 3.4 s | Warn |
| TTI (Time to Interactive) | ≤ 3.8 s | Warn |

### Lighthouse scores

| Category | Floor | Policy |
|---|---|---|
| Performance | ≥ 75 | Warn |
| Accessibility | ≥ 90 | **Fail** |
| Best Practices | ≥ 90 | Warn |

### Asset size ceilings (transfer / gzip, per page load)

| Asset type | Ceiling | Policy |
|---|---|---|
| JavaScript (critical routes) | 300 kB | Warn |
| JavaScript (/booking routes) | 360 kB | Warn — see exception below |
| Images | 600 kB | Warn |
| Total page weight | 1 MB | Warn |

---

## Enforcement

Budgets are enforced automatically in CI via Lighthouse CI (`lighthouserc.js`).

```
# Run locally against a production build
npm run build
npx @lhci/cli@latest autorun
```

The `performance-budgets` GitHub Actions job runs on every PR targeting `main`.
A **Warn** finding is reported as a check annotation but does not block merge.
An **Error/Fail** finding blocks merge until resolved or explicitly excepted.

---

## Lazy-loading strategy

The following heavy libraries are **never loaded on the critical path**. Each uses
a React dynamic import so the bundle is fetched only when the user navigates to a
route that needs it.

| Library | Approx. gzip size | Loaded on |
|---|---|---|
| `@stellar/stellar-sdk` + `@stellar/freighter-api` | ~180 kB | `/booking/*`, `/dashboard/*` |
| `leaflet` + `react-leaflet` | ~40 kB | `/property/:id` (map section) |
| `recharts` | ~80 kB | `/dashboard/*` |

### Implementation pattern

```tsx
// ✅ Lazy-load wallet/Stellar components
import dynamic from 'next/dynamic';

const WalletConnectButton = dynamic(
  () => import('@/components/wallet/WalletConnectButton'),
  { ssr: false, loading: () => <Skeleton className="h-10 w-32" /> },
);

const PropertyMap = dynamic(
  () => import('@/components/properties/PropertyMap'),
  { ssr: false, loading: () => <Skeleton className="w-full h-64 rounded-lg" /> },
);
```

---

## Documented exceptions

| Exception | Reason | Approved | Revisit |
|---|---|---|---|
| `/booking/*` JS ceiling +60 kB | Stellar SDK + Freighter wallet required for payment flow | 2025-09-25 | Next Stellar SDK major |
| Leaflet on `/property/:id` | Map is deferred via dynamic import; does not affect FCP/LCP | 2025-09-25 | If leaflet v2 ships |
| `recharts` on `/dashboard/*` | Charts deferred; admin-only route, lower traffic priority | 2025-09-25 | Q1 2026 review |

---

## Baseline measurements

Measured on 2025-09-25 against `main` at commit `692c838`, throttled mobile profile.

| Route | LCP | TBT | CLS | Perf score | JS size |
|---|---|---|---|---|---|
| `/` (home) | 1.9 s | 180 ms | 0.02 | 82 | 210 kB |
| `/search` | 2.1 s | 220 ms | 0.04 | 78 | 245 kB |
| `/property/:id` | 2.3 s | 240 ms | 0.06 | 76 | 275 kB |
| `/login` | 1.2 s | 90 ms | 0.01 | 94 | 130 kB |
| `/register` | 1.3 s | 95 ms | 0.01 | 93 | 132 kB |

These numbers establish the **baseline**. PRs that cause a metric to exceed its
budget threshold receive a CI annotation. Regressions more than 10% above budget
must be addressed before merge.

---

## Adding a new heavy dependency

1. Check the current bundle size: `ANALYZE=true npm run build` then open
   `apps/web/bundle-report.html`.
2. If the new library adds > 20 kB gzipped, use `next/dynamic` to defer it.
3. Run `npx @lhci/cli@latest autorun` locally and confirm budgets still pass.
4. If an exception is required, add a row to the **Documented exceptions** table
   above and get it approved in PR review.
