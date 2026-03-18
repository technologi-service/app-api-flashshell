import { t } from 'elysia'

export const AdvanceStatusBody = t.Object({
  status: t.Union([t.Literal('picked_up'), t.Literal('delivered')])
})
export type AdvanceStatusBody = typeof AdvanceStatusBody.static
