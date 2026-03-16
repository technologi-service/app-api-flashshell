// src/plugins/consumer/index.ts
import { Elysia } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import { CreateOrderBody } from './model'
import { createOrder, getActiveMenu, getOrderHistory } from './service'

export const consumerPlugin = new Elysia({ name: 'consumer', prefix: '/consumer' })
  .use(authPlugin)
  .use(requireRole('customer'))
  .get('/menu', () => getActiveMenu(), { auth: true })
  .post(
    '/orders',
    async ({ body, user, status }) => {
      const result = await createOrder(user.id, body.items)
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
