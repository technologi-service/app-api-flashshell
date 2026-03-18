import { Pool } from 'pg'
import { db } from '../../db/client'
import { sql } from 'drizzle-orm'

// pg.Pool for transactional queries with SELECT FOR UPDATE.
// Uses DATABASE_DIRECT_URL to bypass PgBouncer — Neon PgBouncer transaction mode
// does not preserve row locks (SELECT FOR UPDATE) across queries within a transaction.
const txPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 5
})

export interface PickupListItem {
  id: string
  status: string
  items: Array<{ name: string; quantity: number }>
  totalAmount: string
  deliveryAddress: string
  createdAt: Date
}

export interface OrderDetail {
  id: string
  status: string
  items: Array<{ name: string; quantity: number }>
  totalAmount: string
  deliveryAddress: string
  courierId: string | null
  createdAt: Date
}

export type GetOrderDetailResult =
  | { found: true; order: OrderDetail }
  | { found: false; reason: 'NOT_FOUND' | 'FORBIDDEN' }

export type AdvanceStatusResult =
  | { ok: true }
  | { ok: false; error: 'INVALID_TRANSITION' | 'ALREADY_CLAIMED' | 'COURIER_BUSY' | 'FORBIDDEN' | 'NOT_FOUND' }

export async function getPickupList(): Promise<PickupListItem[]> {
  const result = await db.execute(sql`
    SELECT o.id, o.status, o.total_amount, o.delivery_address, o.created_at,
           oi.quantity, mi.name AS item_name
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status IN ('preparing', 'ready_for_pickup') AND o.courier_id IS NULL
    ORDER BY o.created_at ASC
  `)

  const rows = (result as any).rows ?? (Array.isArray(result) ? result : [])

  // Aggregate rows by order id
  const orderMap = new Map<string, PickupListItem>()
  for (const row of rows) {
    if (!orderMap.has(row.id)) {
      orderMap.set(row.id, {
        id: row.id,
        status: row.status,
        totalAmount: row.total_amount,
        deliveryAddress: row.delivery_address,
        createdAt: row.created_at,
        items: []
      })
    }
    orderMap.get(row.id)!.items.push({ name: row.item_name, quantity: Number(row.quantity) })
  }

  return Array.from(orderMap.values())
}

export async function getOrderDetail(
  orderId: string,
  courierId: string
): Promise<GetOrderDetailResult> {
  const result = await db.execute(sql`
    SELECT o.id, o.status, o.total_amount, o.delivery_address, o.courier_id, o.created_at,
           oi.quantity, mi.name AS item_name
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.id = ${orderId}::uuid
    ORDER BY mi.name ASC
  `)

  const rows = (result as any).rows ?? (Array.isArray(result) ? result : [])

  if (rows.length === 0) {
    return { found: false, reason: 'NOT_FOUND' }
  }

  const firstRow = rows[0]
  const orderStatus: string = firstRow.status
  const orderCourierId: string | null = firstRow.courier_id

  // Access control: if order is claimed by another courier and not in open statuses, deny
  if (
    orderCourierId !== null &&
    orderCourierId !== courierId &&
    !['preparing', 'ready_for_pickup'].includes(orderStatus)
  ) {
    return { found: false, reason: 'FORBIDDEN' }
  }

  const items = rows.map((row: any) => ({ name: row.item_name, quantity: Number(row.quantity) }))

  return {
    found: true,
    order: {
      id: firstRow.id,
      status: orderStatus,
      totalAmount: firstRow.total_amount,
      deliveryAddress: firstRow.delivery_address,
      courierId: orderCourierId,
      createdAt: firstRow.created_at,
      items
    }
  }
}

export async function advanceOrderStatus(
  orderId: string,
  courierId: string,
  newStatus: 'picked_up' | 'delivered'
): Promise<AdvanceStatusResult> {
  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query<{
      id: string
      status: string
      courier_id: string | null
    }>(
      'SELECT id, status, courier_id FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    )

    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'NOT_FOUND' }
    }

    const order = rows[0]

    if (newStatus === 'picked_up') {
      if (order.status !== 'ready_for_pickup') {
        await client.query('ROLLBACK')
        return { ok: false, error: 'INVALID_TRANSITION' }
      }

      if (order.courier_id !== null) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'ALREADY_CLAIMED' }
      }

      // One-active-order-per-courier constraint
      const { rows: busyRows } = await client.query(
        'SELECT id FROM orders WHERE courier_id = $1 AND status = $2',
        [courierId, 'picked_up']
      )
      if (busyRows.length > 0) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'COURIER_BUSY' }
      }

      await client.query(
        'UPDATE orders SET status = $1, courier_id = $2, updated_at = NOW() WHERE id = $3',
        ['picked_up', courierId, orderId]
      )

      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: `order:${orderId}`, event: 'order_picked_up', orderId, courierId })]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: 'control', event: 'order_picked_up', orderId, courierId })]
      )
    } else {
      // delivered
      if (order.status !== 'picked_up' || order.courier_id !== courierId) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'FORBIDDEN' }
      }

      await client.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
        ['delivered', orderId]
      )

      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: `order:${orderId}`, event: 'order_delivered', orderId })]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: 'control', event: 'order_delivered', orderId })]
      )
    }

    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
