import { db } from '../../db/client'
import { sql } from 'drizzle-orm'

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
    WHERE o.status NOT IN ('delivered', 'cancelled')
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

export async function getCashflowReport(from: string, to: string): Promise<CashflowReport> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(o.total_amount), 0)::text AS total_revenue,
      COALESCE(SUM(oi.quantity::numeric * mii.quantity_used::numeric * i.cost_per_unit::numeric), 0)::text AS total_stock_cost
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    JOIN ingredients i ON i.id = mii.ingredient_id
    WHERE o.status = 'confirmed'
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
