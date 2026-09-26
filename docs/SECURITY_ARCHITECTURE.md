# Security Architecture

## Overview

This document outlines the security design decisions, trust boundaries, and protections implemented in Rentars.

## Token Transport & Authentication

### JWT Bearer Tokens (Primary)

- **Transport**: `Authorization: Bearer <token>` header
- **Storage**: Memory (JavaScript) or secure storage per-client
- **Advantages**:
  - Stateless server-side
  - Works cross-origin without CORS complications
  - Suitable for SPAs and mobile apps
  - No CSRF risk for token bearer itself

### Session Cookies (Optional)

When cookies are used for session management:

- **Flag: `Secure`**: Set to `true` in production. Ensures cookies are only transmitted over HTTPS, preventing interception on unencrypted connections.
- **Flag: `HttpOnly`**: Set to `true`. Blocks JavaScript access via `document.cookie`, mitigating XSS attacks that could steal tokens.
- **Flag: `SameSite: Strict`**: Only sends cookies to same-site requests. Blocks cross-site request forgery (CSRF) attacks.
- **Flag: `Path`**: Set to `/` by default, narrowed to specific routes if needed.
- **Flag: `Max-Age`**: Set appropriately per use case (session cookies: 1-24 hours, CSRF tokens: 1 hour).
- **Signed**: Disabled (Express cookie-parser validation; application-level validation preferred).

Configuration in the codebase:
- Primary session/CSRF cookies: see `csrf.middleware.ts`
- All cookie settings are validated and logged at startup (see `config/env.ts`)

## CSRF Protection

### Mechanism

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) require CSRF token validation:

1. Safe methods (`GET`, `HEAD`, `OPTIONS`) receive a CSRF token in the `__Host-csrf-token` cookie
2. Client-side code must read this token from the cookie and echo it back in the `X-CSRF-Token` header
3. Server validates that header and cookie values match before processing mutations

### Why Double-Submit Cookies?

- No server-side session storage required (stateless)
- Works across multiple browser tabs (shared cookie)
- Leverages browser's same-origin policy for enforcement
- Automatic cleanup (tokens expire server-side per max-age)

### Browser Test Coverage

Tests in `__tests__/csrf-protection.test.ts` verify:
- GET requests receive a fresh CSRF token
- POST requests reject missing CSRF headers
- POST requests reject mismatched header/cookie pairs
- Cross-origin `POST` attempts are rejected (CORS + CSRF)
- Token expiration/refresh behavior

## CORS Configuration

### Design

- **Wildcard Origins**: Rejected at startup (see `config/env.ts`). Wildcards with `credentials: true` violate Fetch spec.
- **Explicit Allow-List**: Defined by `CORS_ORIGIN` environment variable (comma-separated).
- **Credentials**: Enabled (`credentials: true`) to support Authorization headers and session cookies.
- **Methods**: Limited to `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
- **Headers**: Only necessary headers allowed (`Content-Type`, `Authorization`, `X-Request-Id`, `X-CSRF-Token`).
- **Preflight Caching**: 10 minutes (reduces overhead for repeated cross-origin requests).

Configuration in the codebase:
- `middleware/cors.middleware.ts` — CORS origin checking and response headers
- `config/env.ts` — `CORS_ORIGIN` validation at startup

## Secure Headers

### Content-Security-Policy (CSP)

- **default-src 'none'**: Deny everything unless explicitly allowed.
- **script-src 'self'**: Only same-origin scripts (used for Swagger UI).
- **style-src 'self' 'unsafe-inline'**: Same-origin styles + inline (Swagger UI).
- **img-src 'self' data:** Same-origin images + data URIs (Swagger UI icons).
- **frame-ancestors 'none'**: No embedding in iframes (belt-and-suspenders with X-Frame-Options).
- **connect-src 'self'**: XHR/Fetch only to same-origin.
- **form-action 'self'**: Forms can only submit to same-origin.

### Other Headers

- **X-Content-Type-Options: nosniff** — Prevents MIME-sniffing attacks.
- **X-Frame-Options: DENY** — No embedding in iframes.
- **Referrer-Policy: strict-origin-when-cross-origin** — Limits referrer leakage.
- **HSTS** (production only) — Enforces HTTPS for 1 year.
- **X-Permitted-Cross-Domain-Policies: none** — No Flash/PDF policies.

Configuration: `middleware/security.middleware.ts` (Helmet)

## Request Validation & Input Sanitization

### Boundary Validation

Input validation occurs at the system boundary (API endpoints):
- JSON body limits enforced (see `env.JSON_BODY_LIMIT`).
- Request timeouts enforced (see `middleware/timeout.middleware.js`).
- Rate limiting enforced (see `middleware/rateLimiter.ts`).

### Application-Level Validation

Each endpoint validates inputs using Zod schemas in `validators/`.

## File & Image Upload Security

See `SECURITY_FILE_UPLOAD.md` for:
- Server-side type detection (magic bytes)
- Dimension and size limits
- SVG/executable filtering
- Storage path isolation
- Short-lived signed URLs

## Data Export & Deletion Security

See `SECURITY_DATA_LIFECYCLE.md` for:
- Authenticated export requests with reauthentication
- Asynchronous anonymization
- Retention exceptions
- Audit logging

## Threat Model & Testing

A comprehensive threat model is maintained in `THREAT_MODEL.md`:
- Trust boundaries
- Asset inventory
- Threat scenarios (IDOR, privilege escalation, replay, SSRF, injection)
- Mitigations and residual risks
- Security regression suite (see `__tests__/threat-model-*.test.ts`)

## Environment Configuration

All security settings are validated at startup:
- `CORS_ORIGIN` — Rejects wildcards and invalid values
- `HSTS_ENABLED` — Controls HSTS enforcement
- `JWT_SECRET` — Required for token signing
- `NODE_ENV` — Controls production-only settings (HTTPS, HSTS, secure cookies)

See `config/env.ts` for the full validation schema.

## Audit & Logging

Security-relevant events are logged with context:
- CORS origin mismatches
- CSRF token validation failures
- Rate limit exceeds
- Auth failures
- File upload rejections

Logs are structured and include request correlation IDs for tracing.

## Key References

1. OWASP Top 10
2. CWE/SANS Top 25
3. Stellar ecosystem security guidelines
4. Rental marketplace abuse patterns
