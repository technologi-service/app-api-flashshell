import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import {
  AdvanceStatusBody,
  PickupListItemSchema,
  OrderDetailSchema,
  AdvanceStatusResponse
} from './model'
import { getPickupList, getOrderDetail, advanceOrderStatus } from './service'

export const logisticsPlugin = new Elysia({ name: 'logistics', prefix: '/logistics' })
  .use(authPlugin)
  .use(requireRole('delivery'))
  .get('/orders/ready', () => getPickupList(), {
    auth: true,
    response: t.Array(PickupListItemSchema)
  })
  .get(
    '/orders/:id',
    async ({ params, user, status }) => {
      const result = await getOrderDetail(params.id, user.id)
      if (!result.found) {
        const code = result.reason === 'NOT_FOUND' ? 404 : 403
        return status(code, {
          error: result.reason,
          message: result.reason === 'NOT_FOUND'
            ? `Order ${params.id} not found`
            : 'Not authorized to view this order'
        })
      }
      return result.order
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: { 200: OrderDetailSchema }
    }
  )
  .patch(
    '/orders/:id/status',
    async ({ params, body, user, status }) => {
      const result = await advanceOrderStatus(params.id, user.id, body.status)
      if (!result.ok) {
        const statusCode = result.error === 'NOT_FOUND' ? 404
          : result.error === 'FORBIDDEN' ? 403
          : 409  // ALREADY_CLAIMED, COURIER_BUSY, INVALID_TRANSITION
        return status(statusCode, {
          error: result.error,
          message: result.error === 'ALREADY_CLAIMED' ? 'Order already claimed by another courier'
            : result.error === 'COURIER_BUSY' ? 'You already have an active delivery'
            : result.error === 'INVALID_TRANSITION' ? 'Cannot transition from current status'
            : result.error === 'NOT_FOUND' ? 'Order not found'
            : 'Not authorized'
        })
      }
      return { success: true, status: body.status }
    },
    {
      auth: true,
      body: AdvanceStatusBody,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: { 200: AdvanceStatusResponse }
    }
  )
