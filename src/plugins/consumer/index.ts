// src/plugins/consumer/index.ts
import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import {
  CreateOrderBody,
  MenuItemSchema,
  CreatedOrderSchema,
  OrderHistoryItemSchema,
  PayIntentSchema,
  ErrorSchema
} from './model'
import { createOrder, getActiveMenu, getOrderHistory } from './service'
import { createPaymentIntent } from '../payments/service'

export const consumerPlugin = new Elysia({ name: 'consumer', prefix: '/consumer' })
  .use(authPlugin)
  .use(requireRole('customer'))
  .get('/menu', () => getActiveMenu(), {
    auth: true,
    response: t.Array(MenuItemSchema),
    tags: ['consumer'],
    summary: 'Get active menu',
    description: 'Returns all menu items currently marked as available. Only items with `isAvailable: true` are included.'
  })
  .post(
    '/orders',
    async ({ body, user, status }) => {
      const result = await createOrder(user.id, body.items, body.deliveryAddress)
      if (!result.ok) {
        return status(409, {
          error: 'CONFLICT',
          message: 'One or more items are unavailable or out of stock',
          details: result.failures
        })
      }
      return result.order
    },
    {
      auth: true,
      body: CreateOrderBody,
      response: { 200: CreatedOrderSchema, 409: ErrorSchema },
      tags: ['consumer'],
      summary: 'Place an order',
      description: 'Creates a new order in `pending` status. The response includes `expiresAt` — a 30-minute window to complete payment. If the order is not paid before `expiresAt`, it is cancelled automatically and the WebSocket channel `order:{id}` receives an `order_expired` event. Returns 409 if any requested item is unavailable or out of stock. Stock is **not** decremented here — it is decremented atomically in the webhook handler only after Stripe confirms the payment.'
    }
  )
  .get(
    '/orders',
    async ({ user }) => getOrderHistory(user.id),
    {
      auth: true,
      response: t.Array(OrderHistoryItemSchema),
      tags: ['consumer'],
      summary: 'Order history',
      description: 'Returns all orders placed by the authenticated customer, sorted by creation date descending.'
    }
  )
  .post(
    '/orders/:id/pay',
    async ({ params, user, status }) => {
      const result = await createPaymentIntent(params.id, user.id)
      if (!result.ok) {
        if (result.error === 'ORDER_NOT_FOUND') return status(404, { error: 'NOT_FOUND', message: 'Order not found' })
        if (result.error === 'ORDER_NOT_PENDING') return status(409, { error: 'CONFLICT', message: 'Order is not in pending status' })
        if (result.error === 'ORDER_EXPIRED') return status(410, { error: 'ORDER_EXPIRED', message: 'Order expired — the 30-minute payment window has passed' })
        if (result.error === 'INSUFFICIENT_STOCK') return status(409, { error: 'INSUFFICIENT_STOCK', message: 'One or more items are no longer available' })
        return status(400, { error: 'PAYMENT_FAILED', message: result.error })
      }
      return { clientSecret: result.clientSecret }
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: { 200: PayIntentSchema, 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 410: ErrorSchema },
      tags: ['consumer'],
      summary: 'Create payment intent',
      description: [
        'Generates a Stripe `clientSecret` for the given order. Use it with `stripe.confirmCardPayment()` on the frontend.',
        '',
        '**Before calling this endpoint**, connect to the WebSocket channel `order:{id}` to receive real-time payment status.',
        '',
        '**Error codes:**',
        '- `404 NOT_FOUND` — order does not exist or does not belong to the authenticated customer',
        '- `409 ORDER_NOT_PENDING` — order has already been paid or cancelled',
        '- `409 INSUFFICIENT_STOCK` — one or more items are no longer available (stock changed since order was placed)',
        '- `410 ORDER_EXPIRED` — the 30-minute payment window has passed',
        '',
        '**Retries:** calling this endpoint multiple times on the same order cancels the previous PaymentIntent in Stripe and creates a new one — the previous `clientSecret` becomes invalid.',
        '',
        '**Payment confirmation flow:**',
        '1. Connect WebSocket to `order:{id}`',
        '2. Call this endpoint → get `clientSecret`',
        '3. Call `stripe.confirmCardPayment(clientSecret, ...)` — do **not** use this result to show "confirmed" to the user',
        '4. Wait for WebSocket event: `order_confirmed` (success), `payment_failed` (retry available, includes reason + attempts remaining), `order_cancelled` (terminal)',
        '',
        '**Race condition protection:** if stock runs out between payment and webhook processing, the order is cancelled and a full refund is issued automatically via Stripe.'
      ].join('\n')
    }
  )
