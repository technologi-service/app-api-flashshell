// src/plugins/kds/index.ts
// Flash-KDS plugin: chef-side order queue management and menu availability control.
// Routes: GET /kds/orders, PATCH /kds/orders/:id/items/:itemId, PATCH /kds/menu/:itemId/availability
// Auth: .use(authPlugin).use(requireRole('chef')) — returns 403 for non-chef roles
import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import {
  UpdateItemStatusBody,
  ToggleAvailabilityBody,
  KdsActiveOrderSchema,
  UpdateItemStatusResponse,
  ToggleAvailabilityResponse
} from './model'
import { getActiveOrders, updateItemStatus, toggleAvailability } from './service'

export const kdsPlugin = new Elysia({ name: 'kds', prefix: '/kds' })
  .use(authPlugin)
  .use(requireRole('chef'))
  .get('/orders', () => getActiveOrders(), {
    auth: true,
    response: t.Array(KdsActiveOrderSchema)
  })
  .patch(
    '/orders/:id/items/:itemId',
    async ({ params, body, status }) => {
      const result = await updateItemStatus(params.id, params.itemId, body.status)
      if (!result.found) {
        return status(404, {
          error: 'NOT_FOUND',
          message: `Order item ${params.itemId} not found in order ${params.id}`
        })
      }
      return { success: true, advanced: result.advanced }
    },
    {
      auth: true,
      body: UpdateItemStatusBody,
      params: t.Object({
        id: t.String({ format: 'uuid' }),
        itemId: t.String({ format: 'uuid' })
      }),
      response: { 200: UpdateItemStatusResponse }
    }
  )
  .patch(
    '/menu/:itemId/availability',
    async ({ params, body, status }) => {
      const result = await toggleAvailability(params.itemId, body.isAvailable)
      if (!result.found) {
        return status(404, {
          error: 'NOT_FOUND',
          message: `Menu item ${params.itemId} not found`
        })
      }
      return { success: true, isAvailable: body.isAvailable }
    },
    {
      auth: true,
      body: ToggleAvailabilityBody,
      params: t.Object({ itemId: t.String({ format: 'uuid' }) }),
      response: { 200: ToggleAvailabilityResponse }
    }
  )
