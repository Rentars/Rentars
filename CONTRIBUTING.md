# Contributing to Rentars

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Node.js](https://nodejs.org) >= 20
- [Yarn](https://yarnpkg.com) >= 1.22

## Setup

```bash
git clone https://github.com/your-org/rentars.git
cd rentars
yarn install
```

## Turborepo

Rentars uses [Turborepo](https://turbo.build) for monorepo task orchestration. Turbo caches task outputs and runs tasks in parallel, dramatically speeding up local development and CI.

### Common commands

| Command | Description |
|---|---|
| `yarn dev` | Start all apps in dev mode (parallel) |
| `yarn build` | Build all apps (respects dependency order) |
| `yarn test` | Run all test suites |
| `yarn lint` | Lint all packages |

### How the pipeline works

The pipeline is defined in `turbo.json`:

- **`build`** — depends on upstream `build` (e.g. shared packages build first). Outputs are cached in `.next/` and `dist/`.
- **`test`** — depends on `build` so tests always run against fresh build artefacts.
- **`lint`** — no dependencies, runs in parallel across all packages.
- **`dev`** — persistent, never cached.

### Running a single package

```bash
# Build only the backend
yarn turbo run build --filter=rentars-backend

# Test only the web app
yarn turbo run test --filter=web
```

### Remote caching (optional)

Turbo supports remote caching via Vercel to share build caches across machines and CI runs:

```bash
npx turbo login
npx turbo link
```

Once linked, set `TURBO_TOKEN` and `TURBO_TEAM` as CI secrets to enable remote cache hits.

## Conventional Commits

Use [Conventional Commits](https://www.conventionalcommits.org):

```
feat: add wishlist endpoint
fix: correct notification unread count
chore: update turbo pipeline
```

## Pull Requests

1. Branch off `main`: `git checkout -b feat/your-feature`
2. Implement your changes
3. Run `yarn build && yarn test` before opening a PR
4. Reference the issue in your PR description: `closes #123`
