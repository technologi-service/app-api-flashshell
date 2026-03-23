// src/plugins/consumer/index.ts
import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import {
  CreateOrderBody,
  MenuItemSchema,
  CreatedOrderSchema,
  OrderHistoryItemSchema,
  PayIntentSchema
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
      response: { 200: CreatedOrderSchema },
      tags: ['consumer'],
      summary: 'Place an order',
      description: 'Creates a new order in `pending` status. Returns 409 if any requested item is unavailable. After placing the order, call `POST /consumer/orders/:id/pay` to obtain the Stripe `clientSecret` and confirm payment on the frontend.'
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
        return status(400, { error: 'PAYMENT_FAILED', message: result.error })
      }
      return { clientSecret: result.clientSecret }
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: { 200: PayIntentSchema },
      tags: ['consumer'],
      summary: 'Create payment intent',
      description: 'Generates a Stripe `clientSecret` for the given order. Pass this secret to `stripe.confirmCardPayment()` on the frontend. The order must be in `pending` status — returns 409 otherwise. Once Stripe confirms the payment, the order advances to `confirmed` automatically via webhook.'
    }
  )
