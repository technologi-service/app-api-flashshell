import { t } from 'elysia'

// --- Request schemas ---

export const UpdateItemStatusBody = t.Object({
  status: t.Union([t.Literal('preparing'), t.Literal('ready')])
})
export type UpdateItemStatusBody = typeof UpdateItemStatusBody.static

export const ToggleAvailabilityBody = t.Object({
  isAvailable: t.Boolean()
})
export type ToggleAvailabilityBody = typeof ToggleAvailabilityBody.static

// --- Response schemas ---

export const KdsOrderItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  menuItemId: t.String({ format: 'uuid' }),
  quantity: t.Number(),
  unitPrice: t.String(),
  itemStatus: t.Union([t.Literal('pending'), t.Literal('preparing'), t.Literal('ready')]),
  name: t.String()
})

export const KdsActiveOrderSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  customerId: t.String(),
  status: t.Union([
    t.Literal('confirmed'),
    t.Literal('preparing')
  ]),
  totalAmount: t.String(),
  deliveryAddress: t.String(),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  items: t.Array(KdsOrderItemSchema)
})

export const UpdateItemStatusResponse = t.Object({
  success: t.Boolean(),
  advanced: t.Boolean()
})

export const ToggleAvailabilityResponse = t.Object({
  success: t.Boolean(),
  isAvailable: t.Boolean()
})
