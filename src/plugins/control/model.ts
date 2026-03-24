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

// ---- Ingredients ----

export const IngredientCreate = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  unit: t.String({ minLength: 1, maxLength: 30 }),
  stockQuantity: t.Number({ minimum: 0 }),
  criticalThreshold: t.Number({ minimum: 0 }),
  costPerUnit: t.Number({ minimum: 0 })
})
export type IngredientCreate = typeof IngredientCreate.static

export const IngredientUpdate = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  unit: t.Optional(t.String({ minLength: 1, maxLength: 30 })),
  criticalThreshold: t.Optional(t.Number({ minimum: 0 })),
  costPerUnit: t.Optional(t.Number({ minimum: 0 }))
})
export type IngredientUpdate = typeof IngredientUpdate.static

export const IngredientRestock = t.Object({
  amount: t.Number({ minimum: 0.001, description: 'Cantidad a añadir al stock actual' })
})
export type IngredientRestock = typeof IngredientRestock.static

export const IngredientResponse = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  unit: t.String(),
  stockQuantity: t.String(),
  criticalThreshold: t.String(),
  costPerUnit: t.String(),
  updatedAt: t.Date()
})
export type IngredientResponse = typeof IngredientResponse.static

// ---- Menu Items ----

export const MenuItemCreate = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  description: t.Optional(t.String({ maxLength: 500 })),
  price: t.Number({ minimum: 0.01 }),
  isAvailable: t.Optional(t.Boolean())
})
export type MenuItemCreate = typeof MenuItemCreate.static

export const MenuItemUpdate = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  description: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
  price: t.Optional(t.Number({ minimum: 0.01 })),
  isAvailable: t.Optional(t.Boolean())
})
export type MenuItemUpdate = typeof MenuItemUpdate.static

export const MenuItemAdminResponse = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  description: t.Union([t.String(), t.Null()]),
  price: t.String(),
  isAvailable: t.Boolean(),
  createdAt: t.Date(),
  updatedAt: t.Date()
})
export type MenuItemAdminResponse = typeof MenuItemAdminResponse.static

// ---- Recipe (menu_item_ingredients) ----

export const RecipeIngredientSet = t.Object({
  ingredientId: t.String({ format: 'uuid' }),
  quantityUsed: t.Number({ minimum: 0.001 })
})
export type RecipeIngredientSet = typeof RecipeIngredientSet.static

export const RecipeIngredientResponse = t.Object({
  ingredientId: t.String({ format: 'uuid' }),
  name: t.String(),
  unit: t.String(),
  quantityUsed: t.String(),
  stockQuantity: t.String(),
  criticalThreshold: t.String()
})
export type RecipeIngredientResponse = typeof RecipeIngredientResponse.static
