/**
 * Lighthouse CI configuration — Rentars frontend performance budgets.
 *
 * Run locally against a production build:
 *   npm run build && npx @lhci/cli@latest autorun
 *
 * The "performance-budgets" GitHub Actions job in .github/workflows/ci.yml
 * runs this automatically on every PR targeting main.
 *
 * POLICY
 *   warn  → annotates the PR, does not block merge
 *   error → blocks merge until resolved or a documented exception is added
 *
 * THROTTLE PROFILE
 *   Mid-tier Android on fast 4G — the primary Rentars mobile persona.
 *
 * DOCUMENTED EXCEPTIONS (see PERFORMANCE_BUDGETS.md for full rationale)
 *   - Stellar SDK + Freighter (~180 kB gz): lazy-loaded on /booking/* only.
 *   - Leaflet (~40 kB gz): dynamic import on /property/:id only.
 *   - Recharts (~80 kB gz): dynamic import on /dashboard/* only.
 */

'use strict';

/** @type {import('@lhci/cli').LhciConfig} */
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run start',
      startServerReadyPattern: 'Ready on',
      startServerReadyTimeout: 30_000,
      url: [
        'http://localhost:3000/',
        'http://localhost:3000/search',
        'http://localhost:3000/login',
        'http://localhost:3000/register',
      ],
      numberOfRuns: 3,
      settings: {
        throttling: {
          rttMs: 40,
          throughputKbps: 10_240,
          cpuSlowdownMultiplier: 4,
        },
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          disabled: false,
        },
        formFactor: 'mobile',
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
        onlyCategories: ['performance', 'accessibility', 'best-practices'],
      },
    },

    assert: {
      assertions: {
        // ── Lighthouse score floors ──────────────────────────────────────
        'categories:performance':      ['warn',  { minScore: 0.75 }],
        'categories:accessibility':    ['error', { minScore: 0.90 }],
        'categories:best-practices':   ['warn',  { minScore: 0.90 }],

        // ── Core Web Vitals ───────────────────────────────────────────────
        // LCP ≤ 2.5 s
        'largest-contentful-paint':    ['warn', { maxNumericValue: 2500 }],
        // TBT ≤ 300 ms  (proxy for INP < 200 ms)
        'total-blocking-time':         ['warn', { maxNumericValue: 300 }],
        // CLS ≤ 0.10
        'cumulative-layout-shift':     ['warn', { maxNumericValue: 0.1 }],
        // FCP ≤ 1.8 s
        'first-contentful-paint':      ['warn', { maxNumericValue: 1800 }],
        // Speed index ≤ 3.4 s
        'speed-index':                 ['warn', { maxNumericValue: 3400 }],
        // TTI ≤ 3.8 s
        'interactive':                 ['warn', { maxNumericValue: 3800 }],

        // ── Asset size ceilings (transfer / gzip) ─────────────────────────
        // JS: 300 kB for critical routes (home, search, auth)
        'resource-summary:script:size': ['warn', { maxNumericValue: 300_000 }],
        // Images: 600 kB total per page
        'resource-summary:image:size':  ['warn', { maxNumericValue: 600_000 }],
        // Total page weight: 1 MB
        'resource-summary:total:size':  ['warn', { maxNumericValue: 1_000_000 }],

        // ── Accessibility (hard failures) ─────────────────────────────────
        'color-contrast': ['error', { minScore: 1 }],
        'image-alt':      ['error', { minScore: 1 }],
        'label':          ['error', { minScore: 1 }],

        // ── Suppress false-positives in CI localhost ──────────────────────
        'uses-https': 'off',
        'uses-http2': 'off',
      },
    },

    upload: {
      // Store reports as CI artifacts — no external LHCI server required.
      target: 'temporary-public-storage',
    },
  },
};
