/**
 * Payment callback controller (#610).
 *
 * Receives POST webhooks from TrustlessWork / Stellar escrow providers.
 * Raw request bytes are read before Express JSON-parsing so the HMAC is
 * computed over the exact wire bytes.
 *
 * Route:  POST /api/v1/payments/callback
 * Header: X-TrustlessWork-Signature: <hmac-sha256-hex>
 */

import type { Request, Response } from 'express';
import {
  processProviderCallback,
  buildCallbackResponse,
} from '@/services/paymentCallback.service.js';

/**
 * Header carrying the provider's HMAC-SHA256 signature over the raw body.
 * A callback without this header is unauthenticated and must never be
 * allowed to influence booking state.
 */
const SIGNATURE_HEADER = 'x-trustlesswork-signature';

/**
 * Optional header carrying the provider-side event id. When present it is
 * used for replay detection; when absent the service falls back to the
 * signature/body digest.
 */
const EVENT_ID_HEADER = 'x-trustlesswork-event-id';

/**
 * POST /api/v1/payments/callback
 *
 * Expects the raw body to be stored on `req.rawBody` by the body-parser
 * middleware configured in the router (see payment.routes.ts).
 *
 * Never exposes internal error messages in the response.
 */
export async function handlePaymentCallback(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
  const eventId = req.headers[EVENT_ID_HEADER] as string | undefined;

  const webhookSecret = process.env.TRUSTLESS_WORK_WEBHOOK_SECRET ?? '';
  const expectedProviderId = process.env.TRUSTLESS_WORK_PROVIDER_ID ?? '';

  if (!webhookSecret) {
    // Misconfiguration — fail open-safe: reject all callbacks
    res.status(500).json({ status: 'error', message: 'Webhook secret not configured' });
    return;
  }

  // Unauthenticated callbacks are rejected before any state is touched.
  // A missing signature or an empty raw body cannot be verified, so it can
  // never move a booking to a terminal paid/refunded state.
  if (!signature || rawBody.length === 0) {
    res.status(401).json({
      status: 'error',
      message: 'Missing or unverifiable callback signature',
    });
    return;
  }

  const result = await processProviderCallback(
    rawBody,
    signature,
    req.body,
    webhookSecret,
    expectedProviderId,
    eventId,
  );

  // The service never reports a terminal transition unless the event was
  // authenticated and verified. Mismatches and quarantined events surface
  // as non-2xx responses so the provider retries / operators investigate,
  // and the booking is left in its pending state.
  const responseBody = buildCallbackResponse(result.data!);
  const statusCode = result.statusCode ?? (result.success ? 200 : 400);
  res.status(statusCode).json(responseBody);
}
