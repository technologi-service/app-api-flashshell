import { t } from 'elysia'

export const UpdateLocationBody = t.Object({
  lat: t.Number({ minimum: -90, maximum: 90 }),
  lng: t.Number({ minimum: -180, maximum: 180 })
})
export type UpdateLocationBody = typeof UpdateLocationBody.static
