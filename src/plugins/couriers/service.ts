import { db } from '../../db/client'
import { sql } from 'drizzle-orm'
import { courierLocations } from '../../db/schema/logistics'

export async function updateCourierLocation(
  courierId: string,
  lat: number,
  lng: number
): Promise<{ written: boolean; orderId: string | null }> {
  // Step 1 — Find active order (authorization check: courier must have a picked_up order)
  const activeOrder = await db.execute(
    sql`SELECT id FROM orders WHERE courier_id = ${courierId} AND status = 'picked_up' LIMIT 1`
  )
  const orderId = (activeOrder.rows?.[0] as any)?.id ?? null
  if (!orderId) return { written: false, orderId: null }

  // Step 2 — Throttle check: skip write if last update was < 30 seconds ago
  const existing = await db.execute(
    sql`SELECT updated_at FROM courier_locations WHERE courier_id = ${courierId}::uuid`
  )
  if (existing.rows?.length) {
    const age = Date.now() - new Date((existing.rows[0] as any).updated_at).getTime()
    if (age < 30_000) return { written: false, orderId }
  }

  // Step 3 — Upsert location
  await db.insert(courierLocations)
    .values({
      courierId,
      lat: String(lat),
      lng: String(lng),
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: courierLocations.courierId,
      set: {
        lat: String(lat),
        lng: String(lng),
        updatedAt: new Date()
      }
    })

  // Step 4 — Broadcast via pg_notify to customer's order channel
  await db.execute(
    sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
      channel: `order:${orderId}`,
      event: 'courier_location',
      orderId,
      lat,
      lng,
      timestamp: new Date().toISOString()
    })}::text)`
  )

  return { written: true, orderId }
}
