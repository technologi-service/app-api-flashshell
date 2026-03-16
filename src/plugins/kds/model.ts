import { t } from 'elysia'

export const UpdateItemStatusBody = t.Object({
  status: t.Union([t.Literal('preparing'), t.Literal('ready')])
})

export const ToggleAvailabilityBody = t.Object({
  isAvailable: t.Boolean()
})

export type UpdateItemStatusBody = typeof UpdateItemStatusBody.static
export type ToggleAvailabilityBody = typeof ToggleAvailabilityBody.static
