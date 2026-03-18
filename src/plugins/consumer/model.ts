// src/plugins/consumer/model.ts
import { t } from 'elysia'

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
