import { t } from 'elysia'

export const CashflowQuery = t.Object({
  from: t.String({ format: 'date' }),
  to: t.String({ format: 'date' })
})
export type CashflowQuery = typeof CashflowQuery.static

export const CashflowResponse = t.Object({
  totalRevenue: t.String(),
  totalStockCost: t.String()
})
export type CashflowResponse = typeof CashflowResponse.static

export const ActiveOrderItem = t.Object({
  name: t.String(),
  quantity: t.Number()
})

export const ActiveOrder = t.Object({
  id: t.String(),
  status: t.String(),
  totalAmount: t.String(),
  deliveryAddress: t.String(),
  createdAt: t.String(),
  items: t.Array(ActiveOrderItem)
})
export type ActiveOrder = typeof ActiveOrder.static
