# Rollback Runbook

## Selecting a prior release manifest

Release manifests are stored at `docs/releases/manifest-<version>.json`.  Each
manifest records the exact commit, Docker image tag, migration checkpoint, and
ABI hashes that were live at release time.

```bash
# List all manifests newest-first
ls -1t docs/releases/manifest-*.json

# Inspect a specific release
cat docs/releases/manifest-1.2.3.json | jq .
```

## Rollback procedure

1. **Identify the target manifest** — choose the last known-good version.
2. **Check database compatibility** — compare `database.latest_migration` in
   the target manifest against the current migration head.  If the current head
   is ahead, a database downgrade is required (see migration runbooks in
   `docs/admin-runbooks.md`).
3. **Re-deploy the Docker image** — use `release.image_tag` from the target
   manifest to pull and re-deploy the backend and frontend images.
4. **Verify ABI compatibility** — if `components.contracts.version` differs,
   ensure the deployed frontend and backend are compatible with the on-chain
   contracts.  ABI SHA-256 hashes in `contracts.abi_sha256` can be used to
   confirm the correct ABI files are loaded.
5. **Smoke test** — after deployment, run the preview smoke suite:
   ```bash
   SMOKE_API_URL=https://api.your-env.example.com \
   SMOKE_FRONTEND_URL=https://your-env.example.com \
   yarn workspace web playwright test e2e/smoke.spec.ts
   ```
6. **Update incident record** — note the rollback in the incident tracker with
   the manifest version and reason.
