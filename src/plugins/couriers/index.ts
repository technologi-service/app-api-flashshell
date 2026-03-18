import { Elysia } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import { UpdateLocationBody } from './model'
import { updateCourierLocation } from './service'

export const couriersPlugin = new Elysia({ name: 'couriers', prefix: '/couriers' })
  .use(authPlugin)
  .use(requireRole('delivery'))
  .post(
    '/location',
    async ({ body, user, status }) => {
      const result = await updateCourierLocation(user.id, body.lat, body.lng)
      if (result.orderId === null) {
        return status(403, {
          error: 'FORBIDDEN',
          message: 'No active delivery — GPS tracking requires a picked_up order'
        })
      }
      return { ok: true, written: result.written }
    },
    { auth: true, body: UpdateLocationBody }
  )
