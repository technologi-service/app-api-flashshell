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
    response: t.Array(PickupListItemSchema),
    tags: ['logistics'],
    summary: 'Orders ready for pickup',
    description: 'Returns all orders in `ready_for_pickup` status that have not yet been claimed by a courier. Couriers use this list to select their next delivery.'
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
      response: { 200: OrderDetailSchema },
      tags: ['logistics'],
      summary: 'Order detail for delivery',
      description: 'Returns full order detail including delivery address and items. Only the courier assigned to the order can access it — returns 403 for any other delivery user.'
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
      response: { 200: AdvanceStatusResponse },
      tags: ['logistics'],
      summary: 'Advance delivery status',
      description: 'Moves an order through the delivery pipeline: `ready_for_pickup → picked_up → delivered`. Setting `picked_up` claims the order for this courier (returns 409 if already claimed or if courier has another active delivery). Each transition fires a `pg_notify` event to keep the customer and admin WebSocket channels in sync.'
    }
  )
