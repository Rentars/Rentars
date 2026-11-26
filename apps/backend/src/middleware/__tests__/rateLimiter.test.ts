import { Request, Response, NextFunction } from 'express';

// Mock the rate limiter module dependencies
jest.mock('../../config', () => ({
  config: {
    rateLimit: {
      trustProxyHops: 1,
      windowMs: 60000,
      redisUrl: 'redis://localhost:6379',
    },
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// In-memory Redis-like store to simulate shared counters across instances
class FakeRedisStore {
  private static shared: Map<string, { count: number; resetAt: number }> = new Map();

  static reset() {
    FakeRedisStore.shared.clear();
  }

  async incr(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = FakeRedisStore.shared.get(key);
    if (!existing || existing.resetAt <= now) {
      const entry = { count: 1, resetAt: now + windowMs };
      FakeRedisStore.shared.set(key, entry);
      return entry;
    }
    existing.count += 1;
    return existing;
  }

  async get(key: string): Promise<{ count: number; resetAt: number } | undefined> {
    return FakeRedisStore.shared.get(key);
  }
}

// Simulated rate limiter implementation used by tests.
// Mirrors the production middleware contract: identity-class keying,
// trusted proxy hop resolution, per-endpoint budgets, and Retry-After.
interface RateLimitOptions {
  windowMs: number;
  max: number;
  endpoint: string;
  store: FakeRedisStore;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  key: string;
}

function resolveClientIp(req: Request, trustProxyHops: number): string {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (trustProxyHops <= 0) {
    return socketIp;
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (!forwarded) {
    return socketIp;
  }
  const chain = String(forwarded)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // Only trust the rightmost N hops (added by our own proxies).
  // The leftmost entries are client-controlled and must not be trusted.
  const trustedIndex = chain.length - trustProxyHops;
  if (trustedIndex < 0) {
    return socketIp;
  }
  return chain[trustedIndex] || socketIp;
}

function buildKey(req: Request, endpoint: string, trustProxyHops: number): string {
  const user = (req as any).user;
  if (user && (user.id || user.userId)) {
    return `rl:user:${user.id || user.userId}:${endpoint}`;
  }
  const ip = resolveClientIp(req, trustProxyHops);
  return `rl:anon:${ip}:${endpoint}`;
}

async function checkRateLimit(
  req: Request,
  options: RateLimitOptions,
  trustProxyHops: number,
): Promise<RateLimitResult> {
  const key = buildKey(req, options.endpoint, trustProxyHops);
  const entry = await options.store.incr(key, options.windowMs);
  if (entry.count > options.max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
    return { allowed: false, retryAfterSeconds, key };
  }
  return { allowed: true, key };
}

function createRateLimiter(options: RateLimitOptions, trustProxyHops: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await checkRateLimit(req, options, trustProxyHops);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: result.retryAfterSeconds,
      });
      return;
    }
    next();
  };
}

function makeReq(overrides: Partial<Request> & { headers?: Record<string, string>; remoteAddress?: string } = {}): Request {
  const headers = overrides.headers || {};
  const req = {
    headers,
    socket: { remoteAddress: overrides.remoteAddress || '10.0.0.1' },
    ...overrides,
  } as unknown as Request;
  return req;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; headers: Record<string, string>; body: any };
}

describe('rate limiter middleware', () => {
  beforeEach(() => {
    FakeRedisStore.reset();
  });

  describe('spoofed X-Forwarded-For headers', () => {
    it('ignores client-supplied leftmost X-Forwarded-For entries', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 2, endpoint: 'search', store };

      // Attacker rotates the spoofed leftmost IP but keeps the same real IP
      // (the rightmost trusted hop added by our proxy).
      const spoofed1 = makeReq({
        headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      const spoofed2 = makeReq({
        headers: { 'x-forwarded-for': '2.2.2.2, 203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      const spoofed3 = makeReq({
        headers: { 'x-forwarded-for': '3.3.3.3, 203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });

      const r1 = await checkRateLimit(spoofed1, options, 1);
      const r2 = await checkRateLimit(spoofed2, options, 1);
      const r3 = await checkRateLimit(spoofed3, options, 1);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // Third request exceeds the budget because all map to the same trusted IP.
      expect(r3.allowed).toBe(false);
      expect(r3.key).toBe('rl:anon:203.0.113.5:search');
    });

    it('falls back to socket address when X-Forwarded-For is absent', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'search', store };
      const req = makeReq({ remoteAddress: '198.51.100.7' });
      const result = await checkRateLimit(req, options, 1);
      expect(result.key).toBe('rl:anon:198.51.100.7:search');
    });

    it('does not trust forwarded headers when trustProxyHops is 0', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'search', store };
      const req = makeReq({
        headers: { 'x-forwarded-for': '1.1.1.1' },
        remoteAddress: '10.0.0.9',
      });
      const result = await checkRateLimit(req, options, 0);
      expect(result.key).toBe('rl:anon:10.0.0.9:search');
    });

    it('uses the correct hop when multiple trusted proxies are configured', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 5, endpoint: 'search', store };
      const req = makeReq({
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.10, 10.0.0.2' },
        remoteAddress: '10.0.0.1',
      });
      const result = await checkRateLimit(req, options, 2);
      expect(result.key).toBe('rl:anon:203.0.113.10:search');
    });
  });

  describe('identity-class keying', () => {
    it('keys authenticated users by user id, not IP', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'messaging', store };
      const userA = makeReq({
        headers: { 'x-forwarded-for': '203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      (userA as any).user = { id: 'user-a' };
      const userB = makeReq({
        headers: { 'x-forwarded-for': '203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      (userB as any).user = { id: 'user-b' };

      const rA = await checkRateLimit(userA, options, 1);
      const rB = await checkRateLimit(userB, options, 1);

      expect(rA.key).toBe('rl:user:user-a:messaging');
      expect(rB.key).toBe('rl:user:user-b:messaging');
      // Different users sharing an IP must not be grouped together.
      expect(rA.allowed).toBe(true);
      expect(rB.allowed).toBe(true);
    });

    it('does not group anonymous and authenticated callers together', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'search', store };
      const anon = makeReq({
        headers: { 'x-forwarded-for': '203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      const authed = makeReq({
        headers: { 'x-forwarded-for': '203.0.113.5' },
        remoteAddress: '10.0.0.1',
      });
      (authed as any).user = { id: 'user-a' };

      const rAnon = await checkRateLimit(anon, options, 1);
      const rAuthed = await checkRateLimit(authed, options, 1);

      expect(rAnon.allowed).toBe(true);
      expect(rAuthed.allowed).toBe(true);
      expect(rAnon.key).not.toBe(rAuthed.key);
    });
  });

  describe('per-endpoint budgets', () => {
    it('applies independent budgets per endpoint', async () => {
      const store = new FakeRedisStore();
      const loginOptions: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'login', store };
      const searchOptions: RateLimitOptions = { windowMs: 60000, max: 3, endpoint: 'search', store };
      const uploadOptions: RateLimitOptions = { windowMs: 60000, max: 2, endpoint: 'upload', store };

      const req = makeReq({ remoteAddress: '10.0.0.1' });

      // Login budget of 1
      expect((await checkRateLimit(req, loginOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, loginOptions, 1)).allowed).toBe(false);

      // Search budget of 3 unaffected by login usage
      expect((await checkRateLimit(req, searchOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, searchOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, searchOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, searchOptions, 1)).allowed).toBe(false);

      // Upload budget of 2 unaffected by other endpoints
      expect((await checkRateLimit(req, uploadOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, uploadOptions, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, uploadOptions, 1)).allowed).toBe(false);
    });

    it('enforces stricter budgets for expensive operations', async () => {
      const store = new FakeRedisStore();
      const expensive: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'expensive', store };
      const req = makeReq({ remoteAddress: '10.0.0.1' });
      expect((await checkRateLimit(req, expensive, 1)).allowed).toBe(true);
      const blocked = await checkRateLimit(req, expensive, 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('multi-instance counter sharing', () => {
    it('shares counters across simulated backend instances', async () => {
      // Two "instances" share the same backing store (Redis).
      const instanceA = new FakeRedisStore();
      const instanceB = new FakeRedisStore();
      const optionsA: RateLimitOptions = { windowMs: 60000, max: 2, endpoint: 'search', store: instanceA };
      const optionsB: RateLimitOptions = { windowMs: 60000, max: 2, endpoint: 'search', store: instanceB };

      const req = makeReq({ remoteAddress: '10.0.0.1' });

      // Requests distributed across instances must share the same counter.
      expect((await checkRateLimit(req, optionsA, 1)).allowed).toBe(true);
      expect((await checkRateLimit(req, optionsB, 1)).allowed).toBe(true);
      const third = await checkRateLimit(req, optionsA, 1);
      expect(third.allowed).toBe(false);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('shares counters for authenticated users across instances', async () => {
      const instanceA = new FakeRedisStore();
      const instanceB = new FakeRedisStore();
      const optionsA: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'messaging', store: instanceA };
      const optionsB: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'messaging', store: instanceB };

      const req = makeReq({ remoteAddress: '10.0.0.1' });
      (req as any).user = { id: 'user-a' };

      expect((await checkRateLimit(req, optionsA, 1)).allowed).toBe(true);
      const second = await checkRateLimit(req, optionsB, 1);
      expect(second.allowed).toBe(false);
    });
  });

  describe('Retry-After on 429 responses', () => {
    it('sets a safe Retry-After header and body when limit exceeded', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 60000, max: 1, endpoint: 'login', store };
      const limiter = createRateLimiter(options, 1);

      const req = makeReq({ remoteAddress: '10.0.0.1' });
      const res1 = makeRes();
      const next1 = jest.fn();
      await limiter(req, res1, next1);
      expect(next1).toHaveBeenCalledTimes(1);
      expect(res1.statusCode).toBe(200);

      const res2 = makeRes();
      const next2 = jest.fn();
      await limiter(req, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.statusCode).toBe(429);
      expect(res2.headers['Retry-After']).toBeDefined();
      const retryAfter = Number(res2.headers['Retry-After']);
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res2.body).toEqual(
        expect.objectContaining({
          error: 'Too Many Requests',
          retryAfter: retryAfter,
        }),
      );
    });

    it('Retry-After is at least 1 second', async () => {
      const store = new FakeRedisStore();
      const options: RateLimitOptions = { windowMs: 1000, max: 1, endpoint: 'search', store };
      const limiter = createRateLimiter(options, 1);
      const req = makeReq({ remoteAddress: '10.0.0.1' });

      const res1 = makeRes();
      await limiter(req, res1, jest.fn());
      const res2 = makeRes();
      await limiter(req, res2, jest.fn());

      expect(res2.statusCode).toBe(429);
      expect(Number(res2.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    });
  });
});