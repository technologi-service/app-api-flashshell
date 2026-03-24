import { db } from '../../db/client'
import { menuItems, ingredients, menuItemIngredients } from '../../db/schema/menu'
import { orders, orderItems } from '../../db/schema/orders'
import { eq, and, sql } from 'drizzle-orm'

export interface ActiveOrderItem {
  name: string
  quantity: number
}

export interface ActiveOrderResult {
  id: string
  status: string
  totalAmount: string
  deliveryAddress: string
  createdAt: string
  items: ActiveOrderItem[]
}

export interface CashflowReport {
  totalRevenue: string
  totalStockCost: string
}

export async function getActiveOrders(): Promise<ActiveOrderResult[]> {
  const result = await db.execute(sql`
    SELECT o.id, o.status, o.total_amount, o.delivery_address, o.created_at,
           oi.quantity, mi.name AS item_name
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status IN ('confirmed', 'preparing', 'ready_for_pickup', 'picked_up')
    ORDER BY o.created_at ASC
  `)

  const rows = (result as any).rows ?? (Array.isArray(result) ? result : [])

  // Aggregate rows by order id
  const orderMap = new Map<string, ActiveOrderResult>()
  for (const row of rows) {
    if (!orderMap.has(row.id)) {
      orderMap.set(row.id, {
        id: row.id,
        status: row.status,
        totalAmount: row.total_amount,
        deliveryAddress: row.delivery_address,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
        items: []
      })
    }
    orderMap.get(row.id)!.items.push({ name: row.item_name, quantity: Number(row.quantity) })
  }

  return Array.from(orderMap.values())
}

// ---- Ingredients ----

export async function listIngredients() {
  return db.select().from(ingredients).orderBy(ingredients.name)
}

export async function createIngredient(data: {
  name: string
  unit: string
  stockQuantity: number
  criticalThreshold: number
  costPerUnit: number
}) {
  const [row] = await db.insert(ingredients).values({
    name: data.name,
    unit: data.unit,
    stockQuantity: String(data.stockQuantity),
    criticalThreshold: String(data.criticalThreshold),
    costPerUnit: String(data.costPerUnit)
  }).returning()
  return row
}

export async function updateIngredient(id: string, data: {
  name?: string
  unit?: string
  criticalThreshold?: number
  costPerUnit?: number
}) {
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (data.name !== undefined) updates.name = data.name
  if (data.unit !== undefined) updates.unit = data.unit
  if (data.criticalThreshold !== undefined) updates.criticalThreshold = String(data.criticalThreshold)
  if (data.costPerUnit !== undefined) updates.costPerUnit = String(data.costPerUnit)

  const [row] = await db.update(ingredients).set(updates).where(eq(ingredients.id, id)).returning()
  return row ?? null
}

export async function deleteIngredient(id: string): Promise<{ ok: boolean; conflict?: string }> {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(menuItemIngredients)
    .where(eq(menuItemIngredients.ingredientId, id))

  if (Number(count) > 0) {
    return { ok: false, conflict: 'INGREDIENT_IN_USE' }
  }

  const deleted = await db.delete(ingredients).where(eq(ingredients.id, id)).returning()
  if (deleted.length === 0) return { ok: false, conflict: 'NOT_FOUND' }
  return { ok: true }
}

export async function restockIngredient(id: string, amount: number) {
  const [row] = await db
    .update(ingredients)
    .set({
      stockQuantity: sql`stock_quantity + ${String(amount)}::numeric`,
      updatedAt: new Date()
    })
    .where(eq(ingredients.id, id))
    .returning()
  return row ?? null
}

// ---- Menu Items ----

export async function listMenuItemsAdmin() {
  return db.select().from(menuItems).orderBy(menuItems.name)
}

export async function createMenuItem(data: {
  name: string
  description?: string
  price: number
  isAvailable?: boolean
}) {
  const [row] = await db.insert(menuItems).values({
    name: data.name,
    description: data.description ?? null,
    price: String(data.price),
    isAvailable: data.isAvailable ?? true
  }).returning()
  return row
}

export async function updateMenuItem(id: string, data: {
  name?: string
  description?: string | null
  price?: number
  isAvailable?: boolean
}) {
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (data.name !== undefined) updates.name = data.name
  if (data.description !== undefined) updates.description = data.description
  if (data.price !== undefined) updates.price = String(data.price)
  if (data.isAvailable !== undefined) updates.isAvailable = data.isAvailable

  const [row] = await db.update(menuItems).set(updates).where(eq(menuItems.id, id)).returning()
  return row ?? null
}

export async function deleteMenuItem(id: string): Promise<{ ok: boolean; conflict?: string }> {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.menuItemId, id),
        sql`${orders.status} NOT IN ('delivered', 'cancelled')`
      )
    )

  if (Number(count) > 0) {
    return { ok: false, conflict: 'MENU_ITEM_HAS_ACTIVE_ORDERS' }
  }

  const deleted = await db.delete(menuItems).where(eq(menuItems.id, id)).returning()
  if (deleted.length === 0) return { ok: false, conflict: 'NOT_FOUND' }
  return { ok: true }
}

// ---- Recipe (menu_item_ingredients) ----

export async function getMenuItemIngredients(menuItemId: string) {
  return db
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      unit: ingredients.unit,
      quantityUsed: menuItemIngredients.quantityUsed,
      stockQuantity: ingredients.stockQuantity,
      criticalThreshold: ingredients.criticalThreshold
    })
    .from(menuItemIngredients)
    .innerJoin(ingredients, eq(menuItemIngredients.ingredientId, ingredients.id))
    .where(eq(menuItemIngredients.menuItemId, menuItemId))
}

export async function setMenuItemIngredient(
  menuItemId: string,
  ingredientId: string,
  quantityUsed: number
) {
  // delete-then-insert actúa como upsert seguro sin depender de constraints DB
  await db.delete(menuItemIngredients).where(
    and(
      eq(menuItemIngredients.menuItemId, menuItemId),
      eq(menuItemIngredients.ingredientId, ingredientId)
    )
  )
  await db.insert(menuItemIngredients).values({
    menuItemId,
    ingredientId,
    quantityUsed: String(quantityUsed)
  })
}

export async function removeMenuItemIngredient(
  menuItemId: string,
  ingredientId: string
): Promise<boolean> {
  const deleted = await db
    .delete(menuItemIngredients)
    .where(
      and(
        eq(menuItemIngredients.menuItemId, menuItemId),
        eq(menuItemIngredients.ingredientId, ingredientId)
      )
    )
    .returning()
  return deleted.length > 0
}

export async function getCashflowReport(from: string, to: string): Promise<CashflowReport> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(o.total_amount), 0)::text AS total_revenue,
      COALESCE(SUM(oi.quantity::numeric * mii.quantity_used::numeric * i.cost_per_unit::numeric), 0)::text AS total_stock_cost
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    JOIN ingredients i ON i.id = mii.ingredient_id
    WHERE o.status = 'delivered'
      AND o.created_at >= ${from}::timestamptz
      AND o.created_at < ${to}::timestamptz
  `)

  const rows = (result as any).rows ?? (Array.isArray(result) ? result : [])
  const row = rows[0] ?? { total_revenue: '0', total_stock_cost: '0' }

  return {
    totalRevenue: row.total_revenue ?? '0',
    totalStockCost: row.total_stock_cost ?? '0'
  }
}
