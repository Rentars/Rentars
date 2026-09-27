import { getPublicContractVersions } from '@/blockchain/registry.js';
import { getRpcHealth } from '@/blockchain/soroban.js';
import { pingRedis } from '@/config/redis.js';
import { supabase } from '@/config/supabase.js';
import { type Request, type Response, Router } from 'express';

const router = Router();

export type HealthStatus = 'ok' | 'error' | 'not_configured';

/**
 * Probe database connectivity. Never throws — resolves to false on failure.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    const { error } = await supabase.from('properties').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Turn a settled probe result into a health status.
 * `null` means the dependency isn't configured; a rejection is treated as a failure.
 */
export function toHealthStatus(result: PromiseSettledResult<boolean | null>): HealthStatus {
  if (result.status === 'rejected') return 'error';
  if (result.value === null) return 'not_configured';
  return result.value ? 'ok' : 'error';
}

/**
 * Detailed health check endpoint that verifies:
 * - API is running
 * - Database connectivity
 * - Redis connectivity (if configured)
 * - Blockchain RPC status
 *
 * Each dependency is probed concurrently with a bounded timeout. Returns
 * HTTP 503 with status "degraded" if any configured dependency is down.
 */
/**
 * Public contract version metadata (no contract IDs or secrets).
 */
router.get('/health/contracts', (_req: Request, res: Response) => {
  res.status(200).json({
    timestamp: new Date().toISOString(),
    contracts: getPublicContractVersions(),
  });
});

router.get('/health', async (_req: Request, res: Response) => {
  const [databaseResult, redisResult, blockchainResult] = await Promise.allSettled([
    pingDatabase(),
    process.env.REDIS_URL ? pingRedis() : Promise.resolve(null),
    process.env.STELLAR_RPC_URL ? getRpcHealth() : Promise.resolve(null),
  ]);

  const checks: Record<'database' | 'redis' | 'blockchain', HealthStatus> = {
    database: toHealthStatus(databaseResult),
    redis: toHealthStatus(redisResult),
    blockchain: toHealthStatus(blockchainResult),
  };

  const degraded = Object.values(checks).some((check) => check === 'error');

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    service: 'Rentars API 🚀',
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
