// src/plugins/consumer/model.ts
import { t } from 'elysia'

// --- Request schemas ---

export const CreateOrderBody = t.Object({
  items: t.Array(
    t.Object({
      menuItemId: t.String({ format: 'uuid' }),
      quantity: t.Integer({ minimum: 1 })
    }),
    { minItems: 1 }
  ),
  deliveryAddress: t.String({ minLength: 1 })
})
export type CreateOrderBody = typeof CreateOrderBody.static

// --- Response schemas ---

export const MenuItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  description: t.Union([t.String(), t.Null()]),
  price: t.String(),
  isAvailable: t.Boolean()
})

export const OrderItemCreatedSchema = t.Object({
  itemId: t.String({ format: 'uuid' }),
  name: t.String(),
  quantity: t.Number(),
  unitPrice: t.String()
})

export const CreatedOrderSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: t.String(),
  totalAmount: t.String(),
  deliveryAddress: t.String(),
  expiresAt: t.Date({ description: 'La orden expira si no se paga antes de esta fecha (30 minutos desde la creación)' }),
  items: t.Array(OrderItemCreatedSchema)
})

export const OrderHistoryItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: t.String(),
  totalAmount: t.String(),
  createdAt: t.Date()
})

export const PayIntentSchema = t.Object({
  clientSecret: t.String()
})

export const ErrorSchema = t.Object({
  error: t.String(),
  message: t.String()
})
