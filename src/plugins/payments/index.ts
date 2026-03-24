// src/plugins/payments/index.ts
// IMPORTANT: No body schema on /stripe route — intentional.
// Schema parsing would corrupt the raw body needed for Stripe HMAC-SHA256 signature verification.
// Stripe calls this endpoint directly (no auth).
import { Elysia } from 'elysia'
import {
  stripe,
  handlePaymentSucceeded,
  handlePaymentFailed,
  handlePaymentCanceled
} from './service'
import { WebhookResponse } from './model'
import type Stripe from 'stripe'

export const paymentsPlugin = new Elysia({ name: 'payments', prefix: '/webhooks' })
  .post('/stripe', async ({ request, set }) => {
    // No body schema — raw body debe leerse antes de cualquier parsing para la verificación HMAC
    const rawBody = await request.text()
    const signature = request.headers.get('stripe-signature') ?? ''

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch {
      set.status = 400
      return { error: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' }
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const result = await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent)
        if (!result.ok && result.error === 'ALREADY_PROCESSED') {
          return { received: true, duplicate: true }
        }
        break
      }

      case 'payment_intent.payment_failed': {
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent)
        break
      }

      case 'payment_intent.canceled': {
        await handlePaymentCanceled(event.data.object as Stripe.PaymentIntent)
        break
      }
    }

    return { received: true }
  }, {
    response: { 200: WebhookResponse },
    tags: ['payments'],
    summary: 'Stripe webhook receiver',
    description: [
      'Recibe eventos de Stripe y los procesa de forma transaccional:',
      '',
      '**`payment_intent.succeeded`** — verifica stock con `SELECT FOR UPDATE`, decrementa ingredientes, confirma la orden y emite `pg_notify`. Si el stock se agotó entre el pago y el webhook (race condition), cancela la orden y emite un reembolso automático.',
      '',
      '**`payment_intent.payment_failed`** — registra el fallo y notifica al cliente con el motivo. Tras 3 fallos cancela la orden automáticamente.',
      '',
      '**`payment_intent.canceled`** — cancela la orden si sigue en `pending`.',
      '',
      'Todos los eventos son idempotentes. Firma `Stripe-Signature` verificada con HMAC-SHA256.'
    ].join('\n'),
    detail: { security: [] }
  })
