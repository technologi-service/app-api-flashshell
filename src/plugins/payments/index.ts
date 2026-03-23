// src/plugins/payments/index.ts
// IMPORTANT: No body schema on /stripe route — intentional.
// Schema parsing would corrupt the raw body needed for Stripe HMAC-SHA256 signature verification.
// Stripe calls this endpoint directly (no auth).
import { Elysia } from 'elysia'
import { stripe, handlePaymentSucceeded } from './service'
import { WebhookResponse } from './model'
import type Stripe from 'stripe'

export const paymentsPlugin = new Elysia({ name: 'payments', prefix: '/webhooks' })
  .post('/stripe', async ({ request, set }) => {
    // No body schema — raw body must be read before any parsing for HMAC verification
    // CRITICAL: call request.text() BEFORE any body parsing
    const rawBody = await request.text()
    const signature = request.headers.get('stripe-signature') ?? ''

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err) {
      set.status = 400
      return { error: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' }
    }

    if (event.type === 'payment_intent.succeeded') {
      const result = await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent)
      if (!result.ok && result.error === 'ALREADY_PROCESSED') {
        // Idempotent — Stripe retry, already handled
        return { received: true, duplicate: true }
      }
    }

    return { received: true }
  }, {
    response: { 200: WebhookResponse },
    tags: ['payments'],
    summary: 'Stripe webhook receiver',
    description: 'Receives `payment_intent.succeeded` events from Stripe. Verifies the `Stripe-Signature` header using HMAC-SHA256 — requests with invalid signatures are rejected with 400. On success: records the payment intent, advances the order to `confirmed`, and fires a `pg_notify` event to WebSocket channels. Idempotent — duplicate Stripe retries are silently acknowledged.',
    detail: { security: [] }
  })
