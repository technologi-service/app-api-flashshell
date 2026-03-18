// src/plugins/consumer/index.ts
import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import { CreateOrderBody } from './model'
import { createOrder, getActiveMenu, getOrderHistory } from './service'
import { createPaymentIntent } from '../payments/service'

export const consumerPlugin = new Elysia({ name: 'consumer', prefix: '/consumer' })
  .use(authPlugin)
  .use(requireRole('customer'))
  .get('/menu', () => getActiveMenu(), { auth: true })
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
    { auth: true, body: CreateOrderBody }
  )
  .get(
    '/orders',
    async ({ user }) => getOrderHistory(user.id),
    { auth: true }
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
      params: t.Object({ id: t.String({ format: 'uuid' }) })
    }
  )
