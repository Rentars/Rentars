import { type Request, type Response, Router } from 'express';

const router = Router();

/**
 * Resolve the deployed application version from the environment.
 *
 * Falls back to `unknown` when no version metadata is present so the readiness
 * probe never fails solely due to a missing build-time variable.
 */
function resolveVersion(): string {
  return (
    process.env.APP_VERSION ??
    process.env.npm_package_version ??
    process.env.GIT_SHA ??
    'unknown'
  );
}

/**
 * GET /api/v1/readiness
 *
 * Lightweight readiness probe used by post-deploy smoke tests to confirm the
 * API process is serving requests and the version matches expectations.
 *
 * Unlike /health, this endpoint does NOT probe downstream dependencies — it is
 * intentionally fast so smoke tests can poll it immediately after a cold deploy
 * without waiting for database warmup.
 *
 * @openapi
 * /api/v1/readiness:
 *   get:
 *     tags: [Health]
 *     summary: API process readiness probe
 *     responses:
 *       200:
 *         description: Process is ready to serve requests
 */
router.get('/readiness', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ready',
    service: 'rentars-api',
    version: resolveVersion(),
    timestamp: new Date().toISOString(),
  });
});

export default router;