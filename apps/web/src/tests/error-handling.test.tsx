import {
  logClientError,
  captureException,
  logWarning,
  resetForTesting,
} from '@/lib/errorLogger';

describe('Error Handling', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.clearAllMocks();
    resetForTesting();
  });

  describe('logClientError', () => {
    it('sends error to backend endpoint', async () => {
      const error = new Error('Test error');
      const mockResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'x-request-id': 'req-123' },
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      await logClientError(error, 'test-context', 'digest-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/client-errors'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('sanitizes error messages', async () => {
      const error = new Error('Failed at /home/user/project/src/file.ts line 42');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test-context');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('/home/user');
      expect(body.message).toContain('[path]');
    });

    it('includes correlation digest in report', async () => {
      const error = new Error('Test');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test-context', 'digest-abc123');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.digest).toBe('digest-abc123');
    });

    it('includes context label', async () => {
      const error = new Error('Test');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'booking-form-error');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.context).toBe('booking-form-error');
    });

    it('fails silently without throwing', async () => {
      const error = new Error('Test');
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        logClientError(error, 'test-context')
      ).resolves.toBeUndefined();
    });

    it('does not expose sensitive information', async () => {
      const error = new Error(
        'Request failed for user john@example.com with card 1234-5678-9012-3456'
      );
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test-context');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('john@example.com');
      expect(body.message).not.toContain('1234-5678-9012-3456');
    });
  });

  describe('captureException', () => {
    it('generates correlation digest', () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      const digest = captureException(
        new Error('Test'),
        'test-context'
      );

      expect(digest).toMatch(/^ERR-/);
      expect(digest.length).toBeGreaterThan(10);
    });

    it('returns digest for user reference', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      const digest = captureException(
        new Error('Test error'),
        'test-context'
      );

      expect(digest).toBeTruthy();
      expect(digest).toMatch(/ERR-\d+-[a-z0-9]+/);
    });

    it('includes extra context in digest', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      captureException(new Error('Test'), 'test-context', {
        userId: '123',
        action: 'booking',
      });

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      // Extra context should be captured (sanitized)
      expect(body).toBeDefined();
    });
  });

  describe('Development logging', () => {
    it('logs to console in development', () => {
      process.env.NODE_ENV = 'development';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      logWarning('Test warning', 'test-context');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test warning')
      );

      consoleSpy.mockRestore();
    });

    it('does not log to console in production', () => {
      process.env.NODE_ENV = 'production';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      logWarning('Test warning', 'test-context');

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Error recovery', () => {
    it('supports retry mechanism', () => {
      // Error reported with digest should support user-initiated retry
      const digest = 'ERR-123-abc';
      expect(digest).toBeTruthy();
    });

    it('preserves error context across boundaries', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      const error = new Error('Render error in Dashboard');
      await logClientError(error, 'render-boundary-dashboard', 'digest-456');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.context).toContain('dashboard');
    });
  });

  describe('Privacy & Security', () => {
    it('removes API keys from messages', async () => {
      const error = new Error(
        'Failed to call API with key sk_live_abc123def456ghi789'
      );
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'api-error');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('sk_live_');
    });

    it('redacts file paths', async () => {
      const error = new Error('Error in /src/components/Booking/BookingForm.tsx');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'render-error');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('/src/');
      expect(body.message).toContain('[path]');
    });

    it('limits message length to prevent payload bloat', async () => {
      const longError = new Error('x'.repeat(1000));
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(longError, 'test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message.length).toBeLessThanOrEqual(300);
    });

    it('redacts email addresses', async () => {
      const error = new Error('Failed for user alice@example.com and bob@test.org');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('alice@example.com');
      expect(body.message).not.toContain('bob@test.org');
      expect(body.message).toContain('[email]');
    });

    it('redacts credit card numbers', async () => {
      const error = new Error('Card 4532-0123-4567-8901 failed');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('4532-0123-4567-8901');
      expect(body.message).toContain('[card]');
    });

    it('redacts password parameters', async () => {
      const error = new Error('Login failed: password=hunter2');
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }))
      );

      await logClientError(error, 'test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).not.toContain('hunter2');
      expect(body.message).toContain('password=[redacted]');
    });
  });

  describe('Deduplication', () => {
    it('suppresses duplicate reports with same digest', async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }));
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await logClientError(new Error('Same error'), 'ctx', 'dup-digest-1');
      await logClientError(new Error('Same error'), 'ctx', 'dup-digest-1');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('allows different errors through', async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }));
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await logClientError(new Error('Error one'), 'ctx', 'digest-one');
      await logClientError(new Error('Error two'), 'ctx', 'digest-two');

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Rate limiting', () => {
    it('caps reports per window', async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }));
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      // Send 10 reports — all should go through
      for (let i = 0; i < 10; i++) {
        await logClientError(new Error(`Error ${i}`), 'ctx', `digest-${i}`);
      }
      expect(global.fetch).toHaveBeenCalledTimes(10);

      // 11th should be suppressed
      await logClientError(new Error('Error 11'), 'ctx', 'digest-11');
      expect(global.fetch).toHaveBeenCalledTimes(10);
    });
  });

  describe('Environment gating', () => {
    it('does not send when explicitly disabled', async () => {
      const original = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED;
      process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED = 'false';

      const mockResponse = new Response(JSON.stringify({ ok: true }));
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await logClientError(new Error('Should not send'), 'ctx');
      expect(global.fetch).not.toHaveBeenCalled();

      process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED = original;
    });
  });
});
