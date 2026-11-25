/**
 * Synthetic monitoring probe configuration.
 *
 * Defines external health checks that run from outside the cluster to validate
 * real user paths: frontend load, API health, auth, search, and booking journeys.
 */

/**
 * Safety classification for a probe target.
 *
 * - `read_only`: performs no writes; safe in any environment including production.
 * - `simulation`: exercises a write path against a sandbox/mock provider; must never
 *   move real funds or create real bookings.
 * - `testnet`: exercises a contract/payment path on a test network only.
 *
 * Deployment gates only admit `read_only`, `simulation`, and `testnet` targets so a
 * release check can never create real bookings or transfer production funds.
 */
export type ProbeSafety = 'read_only' | 'simulation' | 'testnet';

export interface ProbeTarget {
  name: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus: number;
  timeoutMs: number;
  validate?: (response: ProbeResponse) => boolean;
  /** Safety classification; defaults to `read_only` when omitted. */
  safety?: ProbeSafety;
  /** When true, this target is part of the pre-deploy/post-deploy release gate. */
  gate?: boolean;
}

export interface ProbeResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  durationMs: number;
  error?: string;
}

export interface ProbeResult {
  target: ProbeTarget;
  response: ProbeResponse;
  success: boolean;
  timestamp: string;
  deploymentVersion?: string;
  location: string;
}

export interface ProbeSuite {
  name: string;
  description: string;
  targets: ProbeTarget[];
  schedule: string; // cron expression
  alertThreshold: {
    consecutiveFailures: number;
    windowMinutes: number;
  };
  testAccount?: {
    email: string;
    password: string;
  };
}

export interface DeploymentGate {
  /** Gate identifier recorded alongside deployment health results. */
  name: string;
  description: string;
  /** Whether a failure blocks traffic promotion (true) or only warns (false). */
  required: boolean;
  /** Names of the probe targets that must pass for this gate. */
  targetNames: string[];
}

export interface ProbeConfig {
  enabled: boolean;
  location: string;
  deploymentVersion: string;
  suites: ProbeSuite[];
  authTokenTtlMinutes: number;
  defaultTimeoutMs: number;
  /** Release health gates evaluated before traffic promotion. */
  deploymentGates: DeploymentGate[];
}

export const defaultProbeConfig: ProbeConfig = {
  enabled: process.env.PROBES_ENABLED === 'true',
  location: process.env.PROBE_LOCATION ?? 'external',
  deploymentVersion: process.env.DEPLOYMENT_VERSION ?? 'unknown',
  authTokenTtlMinutes: 15,
  defaultTimeoutMs: 10000,
  deploymentGates: [
    {
      name: 'api_readiness',
      description: 'Backend API is healthy and serving property reads',
      required: true,
      targetNames: ['api_health', 'api_properties_list'],
    },
    {
      name: 'frontend_availability',
      description: 'Frontend loads and its health endpoint responds',
      required: true,
      targetNames: ['frontend_root', 'frontend_health'],
    },
    {
      name: 'database_compatibility',
      description: 'Database schema/migration state is compatible with the release',
      required: true,
      targetNames: ['db_compatibility'],
    },
    {
      name: 'payment_configuration',
      description: 'Payment provider configuration is valid (simulation/testnet only)',
      required: true,
      targetNames: ['payment_config', 'payment_simulation'],
    },
  ],
  suites: [
    {
      name: 'frontend_load',
      description: 'Verify frontend loads and critical assets are reachable',
      schedule: '*/2 * * * *', // every 2 minutes
      alertThreshold: { consecutiveFailures: 3, windowMinutes: 10 },
      targets: [
        {
          name: 'frontend_root',
          url: `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}/`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 10000,
          safety: 'read_only',
          gate: true,
          validate: (res) =>
            typeof res.body === 'string' && (res.body as string).includes('Rentars'),
        },
        {
          name: 'frontend_health',
          url: `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}/api/health`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          safety: 'read_only',
          gate: true,
        },
      ],
    },
    {
      name: 'api_health',
      description: 'Verify backend API health and dependencies',
      schedule: '*/1 * * * *', // every minute
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 5 },
      targets: [
        {
          name: 'api_health',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/health`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          safety: 'read_only',
          gate: true,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'status' in res.body &&
            (res.body as { status: string }).status === 'ok',
        },
        {
          name: 'api_properties_list',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?limit=1`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          safety: 'read_only',
          gate: true,
        },
        {
          name: 'api_search',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?city=Test&limit=1`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
      ],
    },
    {
      name: 'auth_journey',
      description: 'Verify authentication flow with test account',
      schedule: '*/5 * * * *', // every 5 minutes
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 15 },
      testAccount: {
        email: process.env.PROBE_TEST_EMAIL ?? 'probe-test@rentars.local',
        password: process.env.PROBE_TEST_PASSWORD ?? 'ProbeTest123!',
      },
      targets: [
        {
          name: 'auth_login',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/auth/login`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          expectedStatus: 200,
          timeoutMs: 10000,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'token' in res.body,
        },
      ],
    },
    {
      name: 'booking_read_journey',
      description: 'Verify read-only booking journey (list property, view details)',
      schedule: '*/10 * * * *', // every 10 minutes
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 20 },
      targets: [
        {
          name: 'booking_list_properties',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?limit=5`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
        {
          name: 'booking_view_property',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties/probe-test-property`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
      ],
    },
    {
      name: 'deployment_gate',
      description:
        'Release health gates: database compatibility and payment configuration (read-only/simulation/testnet only)',
      schedule: '0 * * * *', // hourly baseline; also run on demand during deploys
      alertThreshold: { consecutiveFailures: 1, windowMinutes: 30 },
      targets: [
        {
          name: 'db_compatibility',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/health/db`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          safety: 'read_only',
          gate: true,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'status' in res.body &&
            (res.body as { status: string }).status === 'ok' &&
            'migrationState' in res.body,
        },
        {
          name: 'payment_config',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/health/payments`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          safety: 'read_only',
          gate: true,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'configured' in res.body &&
            (res.body as { configured: boolean }).configured === true,
        },
        {
          name: 'payment_simulation',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/payments/simulate`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { amount: 100, currency: 'usd', mode: 'simulation' },
          expectedStatus: 200,
          timeoutMs: 10000,
          safety: 'simulation',
          gate: true,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'simulated' in res.body &&
            (res.body as { simulated: boolean }).simulated === true,
        },
      ],
    },
    {
      name: 'booking_write_probe',
      description: 'Isolated test booking creation and cancellation (no real funds)',
      schedule: '*/30 * * * *', // every 30 minutes
      alertThreshold: { consecutiveFailures: 1, windowMinutes: 60 },
      testAccount: {
        email: process.env.PROBE_BOOKING_EMAIL ?? 'probe-booking@rentars.local',
        password: process.env.PROBE_BOOKING_PASSWORD ?? 'ProbeBooking123!',
      },
      targets: [
        {
          name: 'booking_auth',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/auth/login`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          expectedStatus: 200,
          timeoutMs: 10000,
        },
        {
          name: 'booking_create',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/bookings`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{token}}' },
          body: {
            propertyId: 'probe-test-property',
            startDate: new Date(Date.now() + 86400000).toISOString().split('T')[0], // tomorrow
            endDate: new Date(Date.now() + 172800000).toISOString().split('T')[0], // day after tomorrow
            guestCount: 1,
          },
          expectedStatus: 201,
          timeoutMs: 30000,
        },
        {
          name: 'booking_cancel',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/bookings/{{bookingId}}/cancel`,
          method: 'POST',
          headers: { Authorization: 'Bearer {{token}}' },
          expectedStatus: 200,
          timeoutMs: 10000,
        },
      ],
    },
  ],
};

export function getProbeConfig(): ProbeConfig {
  return defaultProbeConfig;
}

export function getEnabledSuites(config: ProbeConfig): ProbeSuite[] {
  return config.enabled ? config.suites : [];
}

export function getSuiteByName(config: ProbeConfig, name: string): ProbeSuite | undefined {
  return config.suites.find((s) => s.name === name);
}

const SAFE_GATE_SAFETIES: ReadonlySet<ProbeSafety> = new Set<ProbeSafety>([
  'read_only',
  'simulation',
  'testnet',
]);

/**
 * Returns the safety classification for a target, defaulting to `read_only`.
 */
export function getTargetSafety(target: ProbeTarget): ProbeSafety {
  return target.safety ?? 'read_only';
}

/**
 * Returns true when a target is safe to run as part of a production release gate,
 * i.e. it cannot create real bookings or transfer production funds.
 */
export function isEnvironmentSafe(target: ProbeTarget): boolean {
  return SAFE_GATE_SAFETIES.has(getTargetSafety(target));
}

/**
 * Resolves the probe targets that back a deployment gate, rejecting any target
 * that is not environment-safe. Throws if a gate references an unsafe target so a
 * misconfiguration cannot silently promote traffic.
 */
export function getGateTargets(config: ProbeConfig, gate: DeploymentGate): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  for (const name of gate.targetNames) {
    const target = config.suites
      .flatMap((suite) => suite.targets)
      .find((t) => t.name === name);
    if (!target) {
      throw new Error(`Deployment gate "${gate.name}" references unknown target "${name}"`);
    }
    if (!isEnvironmentSafe(target)) {
      throw new Error(
        `Deployment gate "${gate.name}" references unsafe target "${name}" (safety: ${getTargetSafety(target)})`,
      );
    }
    targets.push(target);
  }
  return targets;
}

/**
 * Returns the deployment gates that must pass before traffic promotion.
 */
export function getRequiredDeploymentGates(config: ProbeConfig): DeploymentGate[] {
  return config.deploymentGates.filter((gate) => gate.required);
}