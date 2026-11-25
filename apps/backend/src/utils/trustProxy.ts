/**
 * Parses the TRUST_PROXY setting into the value Express expects for `trust proxy`.
 *
 * Behind a load balancer, `req.ip` is the proxy's address unless Express is told
 * which hops to trust. Without this, every client shares one rate-limit bucket.
 *
 * Accepted values:
 *   unset / "" / "false"  → do not trust forwarding headers (default)
 *   "<n>" (integer ≥ 1)    → trust the last n hops in X-Forwarded-For
 *   "10.0.0.0/8,loopback"  → trust only these addresses or subnets
 *
 * "true" is rejected: it trusts any client-supplied X-Forwarded-For value,
 * which lets an attacker pick their own rate-limit key.
 */
export type TrustProxySetting = false | number | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return false;

  if (value === 'true') {
    throw new Error(
      'TRUST_PROXY=true is not allowed: it trusts any client-supplied X-Forwarded-For. ' +
        'Set a hop count (e.g. "1") or an explicit list of trusted proxy addresses.'
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1) throw new Error('TRUST_PROXY hop count must be at least 1');
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  return entries;
}

/**
 * Minimal shape of the Express request fields needed to resolve a client IP.
 * Kept structural so this helper can be unit-tested without a full Request.
 */
export interface ClientIpRequest {
  ip?: string;
  ips?: string[];
  socket?: { remoteAddress?: string };
}

/**
 * Resolves the real client IP for rate-limit keying.
 *
 * Express already applies the `trust proxy` setting when populating `req.ip`
 * and `req.ips`:
 *   - `req.ips` contains the X-Forwarded-For chain, left-to-right, but only
 *     entries that come from trusted proxies are retained.
 *   - `req.ip` is the left-most untrusted address (the real client) when
 *     proxies are trusted, otherwise the direct socket peer.
 *
 * We therefore prefer `req.ip` and fall back to the right-most `req.ips`
 * entry (the closest hop) and finally the socket peer. We never read the raw
 * X-Forwarded-For header, so spoofed entries are ignored.
 */
export function resolveClientIp(req: ClientIpRequest): string {
  const direct = normalizeIp(req.ip);
  if (direct) return direct;

  const ips = req.ips;
  if (Array.isArray(ips) && ips.length > 0) {
    // Right-most entry is the hop closest to us and the least spoofable.
    const closest = normalizeIp(ips[ips.length - 1]);
    if (closest) return closest;
  }

  const peer = normalizeIp(req.socket?.remoteAddress);
  if (peer) return peer;

  return 'unknown';
}

/**
 * Normalizes an IP string: trims whitespace, strips IPv6 brackets and an
 * IPv4-mapped IPv6 prefix so the same client always maps to one key.
 */
function normalizeIp(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  let ip = value.trim();
  if (ip === '') return undefined;

  // Strip surrounding brackets from bracketed IPv6 (e.g. "[::1]").
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];

  return ip;
}