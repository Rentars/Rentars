/**
 * Search monitoring controller — Issue 592
 * Exposes endpoints for search performance metrics and dashboard data.
 * Requires admin authentication for access to sensitive metrics.
 */

import type { Request, Response } from 'express';
import {
  getSearchPerformanceStats,
  getLatencyPercentiles,
  getCacheMetrics,
  checkPerformanceAlerts,
  runSearchBenchmark,
  exportPrometheusMetrics,
} from '../services/searchPerformance.service.js';

/**
 * GET /api/v1/admin/search/metrics
 * Returns comprehensive search performance statistics.
 * Query params:
 *   - hours: number (default: 24) — time window in hours
 */
export async function getSearchMetricsEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const hours = Math.min(Number(req.query.hours) || 24, 720); // Max 30 days

    const result = await getSearchPerformanceStats(hours);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve search metrics' });
  }
}

/**
 * GET /api/v1/admin/search/latency
 * Returns latency percentiles (p50, p75, p95, p99).
 * Query params:
 *   - startDate: ISO date string
 *   - endDate: ISO date string
 */
export async function getLatencyPercentlesEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const startDate = (req.query.startDate as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endDate = (req.query.endDate as string) || new Date().toISOString();

    const result = await getLatencyPercentiles(startDate, endDate);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve latency percentiles' });
  }
}

/**
 * GET /api/v1/admin/search/cache
 * Returns cache performance metrics (hit rate, hits, misses).
 * Query params:
 *   - startDate: ISO date string
 *   - endDate: ISO date string
 */
export async function getCacheMetricsEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const startDate = (req.query.startDate as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endDate = (req.query.endDate as string) || new Date().toISOString();

    const result = await getCacheMetrics(startDate, endDate);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve cache metrics' });
  }
}

/**
 * GET /api/v1/admin/search/alerts
 * Checks if any performance alerts should be triggered.
 * Query params:
 *   - hours: number (default: 1) — time window in hours
 */
export async function checkPerformanceAlertsEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const hours = Math.min(Number(req.query.hours) || 1, 24);

    const result = await checkPerformanceAlerts(hours);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check performance alerts' });
  }
}

/**
 * POST /api/v1/admin/search/benchmark
 * Runs a benchmark test with the specified number of properties.
 * Body:
 *   - propertyCount: number (default: 10000) — number of properties to simulate
 *
 * Warning: This endpoint may take time to complete and should be run during
 * off-peak hours to avoid impacting production search performance.
 */
export async function runBenchmarkEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const propertyCount = Math.min(Number(req.body?.propertyCount) || 10000, 100000);

    // Set a longer timeout for benchmark operations
    const result = await runSearchBenchmark(propertyCount);

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to run benchmark' });
  }
}

/**
 * GET /api/v1/admin/search/metrics/prometheus
 * Exports metrics in Prometheus format for integration with monitoring stacks.
 * Returns plain text in Prometheus exposition format.
 */
export async function getPrometheusMetricsEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const hours = Math.min(Number(req.query.hours) || 1, 24);

    const statsResult = await getSearchPerformanceStats(hours);

    if (!statsResult.success || !statsResult.data) {
      res.status(500).json({ error: 'Failed to retrieve metrics' });
      return;
    }

    const prometheusMetrics = exportPrometheusMetrics(statsResult.data);

    res.contentType('text/plain; version=0.0.4');
    res.send(prometheusMetrics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to export Prometheus metrics' });
  }
}

/**
 * GET /api/v1/admin/search/dashboard
 * Returns a comprehensive dashboard view with all key metrics.
 * Used by monitoring dashboards (Grafana, custom dashboards, etc).
 */
export async function getDashboardDataEndpoint(req: Request, res: Response): Promise<void> {
  try {
    const hours = Math.min(Number(req.query.hours) || 24, 720);

    const [statsResult, alertsResult] = await Promise.all([
      getSearchPerformanceStats(hours),
      checkPerformanceAlerts(1), // Check last hour for alerts
    ]);

    if (!statsResult.success || !alertsResult.success) {
      res.status(500).json({ error: 'Failed to retrieve dashboard data' });
      return;
    }

    const dashboard = {
      timestamp: new Date().toISOString(),
      period: `${hours}h`,
      stats: statsResult.data,
      alerts: alertsResult.data?.alerts || [],
      health: {
        latency: !alertsResult.data?.latencyAlert,
        cache: !alertsResult.data?.cacheAlert,
        errors: !alertsResult.data?.errorAlert,
        overall: !alertsResult.data?.alerts || alertsResult.data.alerts.length === 0,
      },
    };

    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve dashboard data' });
  }
}
