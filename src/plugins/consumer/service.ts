// src/plugins/consumer/service.ts
import { Pool } from 'pg'
import { db } from '../../db/client'
import { menuItems } from '../../db/schema/menu'
import { orders } from '../../db/schema/orders'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

// pg.Pool para escrituras transaccionales (order + order_items en un solo COMMIT).
// Usamos DATABASE_DIRECT_URL para evitar PgBouncer transaction mode.
const txPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 5
})

export interface OrderItemInput {
  menuItemId: string
  quantity: number
}

export interface CreatedOrder {
  id: string
  status: string
  totalAmount: string
  deliveryAddress: string
  expiresAt: Date
  items: Array<{ itemId: string; name: string; quantity: number; unitPrice: string }>
}

export type CreateOrderResult =
  | { ok: true; order: CreatedOrder }
  | { ok: false; failures: string[] }

export async function createOrder(
  customerId: string,
  items: OrderItemInput[],
  deliveryAddress: string
): Promise<CreateOrderResult> {
  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    const menuItemIds = items.map(i => i.menuItemId)

    // Leer datos de menú e ingredientes (sin bloqueo — solo validación previa al pago)
    const { rows: menuRows } = await client.query<{
      menu_item_id: string
      name: string
      price: string
      is_available: boolean
      ingredient_id: string | null
      stock_quantity: string | null
      quantity_used: string | null
    }>(
      `SELECT
        mi.id AS menu_item_id,
        mi.name,
        mi.price,
        mi.is_available,
        i.id AS ingredient_id,
        i.stock_quantity,
        mii.quantity_used
       FROM menu_items mi
       LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
       LEFT JOIN ingredients i ON i.id = mii.ingredient_id
       WHERE mi.id = ANY($1::uuid[])`,
      [menuItemIds]
    )

    // Agrupar por ítem
    type MenuAgg = {
      name: string
      price: string
      isAvailable: boolean
      ingredients: Array<{ id: string; stockQuantity: number; quantityUsed: number }>
    }
    const menuMap = new Map<string, MenuAgg>()
    for (const row of menuRows) {
      if (!menuMap.has(row.menu_item_id)) {
        menuMap.set(row.menu_item_id, {
          name: row.name,
          price: row.price,
          isAvailable: row.is_available,
          ingredients: []
        })
      }
      if (row.ingredient_id && row.stock_quantity !== null && row.quantity_used !== null) {
        menuMap.get(row.menu_item_id)!.ingredients.push({
          id: row.ingredient_id,
          stockQuantity: Number(row.stock_quantity),
          quantityUsed: Number(row.quantity_used)
        })
      }
    }

    // Validar disponibilidad — recopilar TODOS los fallos antes de rechazar
    const failures: string[] = []
    for (const item of items) {
      const menu = menuMap.get(item.menuItemId)
      if (!menu || !menu.isAvailable) {
        failures.push(item.menuItemId)
        continue
      }
      for (const ing of menu.ingredients) {
        if (ing.stockQuantity < item.quantity * ing.quantityUsed) {
          failures.push(item.menuItemId)
          break
        }
      }
    }

    if (failures.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, failures }
    }

    // IMPORTANTE: el stock NO se decrementa aquí.
    // El decremento ocurre en el webhook payment_intent.succeeded, dentro de una
    // transacción con SELECT FOR UPDATE sobre los ingredientes, garantizando que
    // solo se descuenta stock cuando el pago es confirmado por Stripe.

    const totalAmount = items.reduce((sum, item) => {
      const price = Number(menuMap.get(item.menuItemId)!.price)
      return sum + price * item.quantity
    }, 0).toFixed(2)

    // Insertar orden — expires_at = 30 minutos desde ahora
    const { rows: orderRows } = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO orders (customer_id, status, total_amount, delivery_address, expires_at)
       VALUES ($1, 'pending', $2, $3, NOW() + INTERVAL '30 minutes')
       RETURNING id, expires_at`,
      [customerId, totalAmount, deliveryAddress]
    )
    const orderId = orderRows[0].id
    const expiresAt = orderRows[0].expires_at

    // Insertar ítems de la orden
    const orderItemsResult: CreatedOrder['items'] = []
    for (const item of items) {
      const menu = menuMap.get(item.menuItemId)!
      const { rows: itemRows } = await client.query<{ id: string }>(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id`,
        [orderId, item.menuItemId, item.quantity, menu.price]
      )
      orderItemsResult.push({
        itemId: itemRows[0].id,
        name: menu.name,
        quantity: item.quantity,
        unitPrice: menu.price
      })
    }

    await client.query('COMMIT')

    return {
      ok: true,
      order: {
        id: orderId,
        status: 'pending',
        totalAmount,
        deliveryAddress,
        expiresAt,
        items: orderItemsResult
      }
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function getActiveMenu() {
  return db.select({
    id: menuItems.id,
    name: menuItems.name,
    description: menuItems.description,
    price: menuItems.price,
    isAvailable: menuItems.isAvailable
  }).from(menuItems).where(eq(menuItems.isAvailable, true))
}

export async function getOrderHistory(customerId: string) {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt
    })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(sql`${orders.createdAt} DESC`)
}
