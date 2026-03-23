import { t } from 'elysia'

// --- Request schemas ---

export const AdvanceStatusBody = t.Object({
  status: t.Union([t.Literal('picked_up'), t.Literal('delivered')])
})
export type AdvanceStatusBody = typeof AdvanceStatusBody.static

// --- Response schemas ---

const LogisticsOrderItemSchema = t.Object({
  name: t.String(),
  quantity: t.Number()
})

export const PickupListItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: t.String(),
  totalAmount: t.String(),
  deliveryAddress: t.String(),
  createdAt: t.Date(),
  items: t.Array(LogisticsOrderItemSchema)
})

export const OrderDetailSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: t.String(),
  totalAmount: t.String(),
  deliveryAddress: t.String(),
  courierId: t.Union([t.String(), t.Null()]),
  createdAt: t.Date(),
  items: t.Array(LogisticsOrderItemSchema)
})

export const AdvanceStatusResponse = t.Object({
  success: t.Boolean(),
  status: t.Union([t.Literal('picked_up'), t.Literal('delivered')])
})
