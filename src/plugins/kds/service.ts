import { db } from '../../db/client'
import { sql, inArray, eq } from 'drizzle-orm'
import { orders, orderItems } from '../../db/schema/orders'
import { menuItems } from '../../db/schema/menu'

export async function getActiveOrders() {
  // Get orders with status confirmed or preparing (KDS watches confirmed orders)
  const activeOrders = await db
    .select()
    .from(orders)
    .where(inArray(orders.status, ['confirmed', 'preparing']))

  if (activeOrders.length === 0) return []

  const orderIds = activeOrders.map(o => o.id)
  const items = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      itemStatus: orderItems.itemStatus,
      name: menuItems.name,
    })
    .from(orderItems)
    .leftJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(inArray(orderItems.orderId, orderIds))

  return activeOrders.map(order => ({
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    totalAmount: order.totalAmount,
    deliveryAddress: order.deliveryAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: items
      .filter(i => i.orderId === order.id)
      .map(i => ({
        id: i.id,
        menuItemId: i.menuItemId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        itemStatus: i.itemStatus,
        name: i.name ?? 'Ítem sin nombre',
      })),
  }))
}

export async function updateItemStatus(
  orderId: string,
  itemId: string,
  newStatus: 'preparing' | 'ready'
): Promise<{ found: boolean; advanced: boolean }> {
  // Update the item status
  const updated = await db
    .update(orderItems)
    .set({ itemStatus: newStatus })
    .where(
      sql`${orderItems.id} = ${itemId}::uuid AND ${orderItems.orderId} = ${orderId}::uuid`
    )
    .returning({ id: orderItems.id })

  if (updated.length === 0) {
    return { found: false, advanced: false }
  }

  // Notify consumer's order channel about the item status change (CONS-06)
  await db.execute(
    sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
      channel: `order:${orderId}`,
      event: 'item_status_changed',
      orderId,
      itemId,
      status: newStatus
    })}::text)`
  )

  // Auto-advance check: atomic UPDATE that only succeeds if ALL items are ready.
  // Uses NOT EXISTS subquery — prevents race condition from Pitfall 4 in RESEARCH.md.
  // If 0 rows returned, either another request already advanced it, or items remain.
  let advanced = false
  if (newStatus === 'ready') {
    const advanceResult = await db.execute(
      sql`UPDATE orders
          SET status = 'ready_for_pickup', updated_at = NOW()
          WHERE id = ${orderId}::uuid
            AND status IN ('confirmed', 'preparing')
            AND NOT EXISTS (
              SELECT 1 FROM order_items
              WHERE order_id = ${orderId}::uuid
                AND item_status != 'ready'
            )
          RETURNING id`
    )

    // drizzle-orm/neon-http returns rows in the result array directly
    const rowCount = (advanceResult as any).rows?.length ?? (Array.isArray(advanceResult) ? advanceResult.length : 0)
    if (rowCount > 0) {
      advanced = true

      // Notify kds that order is done (KDS-04 via auto-advance)
      await db.execute(
        sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
          channel: 'kds',
          event: 'order_ready',
          orderId
        })}::text)`
      )

      // Notify logistics that order is ready for pickup
      await db.execute(
        sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
          channel: 'logistics',
          event: 'order_ready_for_pickup',
          orderId
        })}::text)`
      )

      // Notify consumer that order reached ready_for_pickup (order-level event)
      await db.execute(
        sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
          channel: `order:${orderId}`,
          event: 'order_status_changed',
          orderId,
          status: 'ready_for_pickup'
        })}::text)`
      )

      // Notify admin dashboard
      await db.execute(
        sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
          channel: 'control',
          event: 'order_ready_for_pickup',
          orderId
        })}::text)`
      )
    }
  }

  return { found: true, advanced }
}

export async function toggleAvailability(
  itemId: string,
  isAvailable: boolean
): Promise<{ found: boolean }> {
  const updated = await db
    .update(menuItems)
    .set({ isAvailable, updatedAt: new Date() })
    .where(eq(menuItems.id, itemId))
    .returning({ id: menuItems.id })

  return { found: updated.length > 0 }
}
