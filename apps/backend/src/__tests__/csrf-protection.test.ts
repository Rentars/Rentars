import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { csrfMiddleware, csrfTokenMiddleware } from '../middleware/csrf.middleware.js';
import { errorMiddleware } from '../middleware/error.middleware.js';

interface CsrfRequest extends Request {
  csrfToken?: string;
}

function makeApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  app.use(csrfTokenMiddleware);
  app.use(csrfMiddleware);

  app.get('/token', (req: CsrfRequest, res: Response) => {
    res.json({ csrfToken: req.csrfToken });
  });

  app.get('/safe', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/mutation', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.put('/resource/:id', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.patch('/resource/:id', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.delete('/resource/:id', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use(errorMiddleware);

  return app;
}

describe('CSRF protection — token generation', () => {
  const app = makeApp();

  it('generates a CSRF token for safe GET requests', async () => {
    const res = await request(app).get('/safe');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const csrfCookie = cookies?.find((c: string) => c.includes('__Host-csrf-token'));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toContain('HttpOnly=false');
    expect(csrfCookie).toContain('SameSite=Strict');
  });

  it('generates a fresh token on each safe request', async () => {
    const res1 = await request(app).get('/safe');
    const res2 = await request(app).get('/safe');

    const cookie1 = res1.headers['set-cookie']
      ?.find((c: string) => c.includes('__Host-csrf-token'))
      ?.split(';')[0]
      .split('=')[1];
    const cookie2 = res2.headers['set-cookie']
      ?.find((c: string) => c.includes('__Host-csrf-token'))
      ?.split(';')[0]
      .split('=')[1];

    expect(cookie1).toBeDefined();
    expect(cookie2).toBeDefined();
    expect(cookie1).not.toBe(cookie2);
  });

  it('cookie is not HttpOnly (client JS needs to read it)', async () => {
    const res = await request(app).get('/safe');
    const cookies = res.headers['set-cookie'];
    const csrfCookie = cookies?.find((c: string) => c.includes('__Host-csrf-token'));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toContain('HttpOnly=false');
  });

  it('cookie uses SameSite=Strict', async () => {
    const res = await request(app).get('/safe');
    const cookies = res.headers['set-cookie'];
    const csrfCookie = cookies?.find((c: string) => c.includes('__Host-csrf-token'));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toContain('SameSite=Strict');
  });
});

describe('CSRF protection — mutation validation', () => {
  const app = makeApp();

  it('POST without CSRF token is rejected (403)', async () => {
    const res = await request(app).post('/mutation').send({ data: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('POST with mismatched header/cookie tokens is rejected (403)', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));
    const realToken = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .post('/mutation')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .set('X-CSRF-Token', 'wrong-token')
      .send({ data: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('POST with matching header/cookie tokens is accepted (200)', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));
    const token = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .post('/mutation')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .set('X-CSRF-Token', token || '')
      .send({ data: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('PUT requires CSRF token', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));
    const token = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .put('/resource/123')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .set('X-CSRF-Token', token || '')
      .send({ name: 'updated' });

    expect(res.status).toBe(200);
  });

  it('PATCH requires CSRF token', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));
    const token = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .patch('/resource/123')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .set('X-CSRF-Token', token || '')
      .send({ name: 'patched' });

    expect(res.status).toBe(200);
  });

  it('DELETE requires CSRF token', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));
    const token = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .delete('/resource/123')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .set('X-CSRF-Token', token || '');

    expect(res.status).toBe(200);
  });
});

describe('CSRF protection — safe methods exempt', () => {
  const app = makeApp();

  it('GET is safe and does not need CSRF token', async () => {
    const res = await request(app).get('/safe');
    expect(res.status).toBe(200);
  });

  it('HEAD is safe and does not need CSRF token', async () => {
    const res = await request(app).head('/safe');
    expect(res.status).toBe(200);
  });

  it('OPTIONS is safe and does not need CSRF token', async () => {
    const res = await request(app).options('/safe');
    expect(res.status).toBe(200);
  });
});

describe('CSRF protection — missing components', () => {
  const app = makeApp();

  it('POST with token in header but no cookie is rejected', async () => {
    const res = await request(app)
      .post('/mutation')
      .set('X-CSRF-Token', 'some-token')
      .send({ data: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('POST with token in cookie but no header is rejected', async () => {
    const tokenRes = await request(app).get('/safe');
    const setCookie = tokenRes.headers['set-cookie'];
    const csrfCookie = setCookie?.find((c: string) => c.includes('__Host-csrf-token'));

    const res = await request(app)
      .post('/mutation')
      .set('Cookie', csrfCookie?.split(';')[0] || '')
      .send({ data: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });
});
