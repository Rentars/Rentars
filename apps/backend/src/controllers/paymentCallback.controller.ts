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
 * POST /api/v1/payments/callback
 *
 * Expects the raw body to be stored on `req.rawBody` by the body-parser
 * middleware configured in the router (see payment.routes.ts).
 *
 * Never exposes internal error messages in the response.
 */
export async function handlePaymentCallback(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const signature = req.headers['x-trustlesswork-signature'] as string | undefined;

  const webhookSecret = process.env.TRUSTLESS_WORK_WEBHOOK_SECRET ?? '';
  const expectedProviderId = process.env.TRUSTLESS_WORK_PROVIDER_ID ?? '';

  if (!webhookSecret) {
    // Misconfiguration — fail open-safe: reject all callbacks
    res.status(500).json({ status: 'error', message: 'Webhook secret not configured' });
    return;
  }

  const result = await processProviderCallback(
    rawBody,
    signature,
    req.body,
    webhookSecret,
    expectedProviderId,
  );

  const responseBody = buildCallbackResponse(result.data!);
  res.status(result.statusCode ?? (result.success ? 200 : 400)).json(responseBody);
}
