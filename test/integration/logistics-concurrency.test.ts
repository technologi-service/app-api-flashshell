// test/integration/logistics-concurrency.test.ts
// LOGI-04: Integration test for concurrent courier assignment race condition.
// Proves that two couriers claiming the same order simultaneously results in
// exactly one success — SELECT FOR UPDATE serializes concurrent claims.
//
// This test uses direct pg.Pool queries to avoid contamination from mock.module() calls
// in unit test files (Bun 1.3.9 shares module registry across test files in the same run).
//
// Skipped automatically when DATABASE_DIRECT_URL is not a real Neon/Postgres URL.
// To run manually: DATABASE_DIRECT_URL=<real-url> bun test test/integration/logistics-concurrency.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'

// Skip integration tests when DATABASE_URL is the placeholder (unit test environments)
const DATABASE_DIRECT_URL = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? ''
const isRealDb = (DATABASE_DIRECT_URL.includes('neon.tech') || DATABASE_DIRECT_URL.includes('postgres://'))
  && !DATABASE_DIRECT_URL.includes('placeholder')

const describeIfRealDb = isRealDb ? describe : describe.skip

/**
 * Mirrors advanceOrderStatus() SELECT FOR UPDATE logic from logistics/service.ts.
 * Uses direct pg.Pool to avoid mock.module() contamination.
 */
async function claimOrderDirect(
  pool: Pool,
  orderId: string,
  courierId: string
): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT id, status, courier_id FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    )
    const order = rows[0]
    if (!order || order.status !== 'ready_for_pickup' || order.courier_id !== null) {
      await client.query('ROLLBACK')
      return { ok: false, error: order?.courier_id ? 'ALREADY_CLAIMED' : 'INVALID' }
    }
    // Check one-active-order constraint
    const { rows: active } = await client.query(
      "SELECT id FROM orders WHERE courier_id = $1 AND status = 'picked_up'",
      [courierId]
    )
    if (active.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'COURIER_BUSY' }
    }
    await client.query(
      "UPDATE orders SET status = 'picked_up', courier_id = $1, updated_at = NOW() WHERE id = $2",
      [courierId, orderId]
    )
    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

describeIfRealDb('LOGI-04: Concurrent courier claim race condition', () => {
  let pool: Pool
  let orderId: string
  let courierAId: string
  let courierBId: string
  let menuItemId: string
  let ingredientId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_DIRECT_URL, max: 10 })

    // Seed: create two test couriers
    const ca = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, email, name, created_at, updated_at, role)
       VALUES ('courier-test-a', 'logconctest-a@test.invalid', 'LogConcA', NOW(), NOW(), 'delivery')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    courierAId = ca.rows[0].id

    const cb = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, email, name, created_at, updated_at, role)
       VALUES ('courier-test-b', 'logconctest-b@test.invalid', 'LogConcB', NOW(), NOW(), 'delivery')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    courierBId = cb.rows[0].id

    // Seed: create ingredient and menu item
    const ing = await pool.query<{ id: string }>(
      `INSERT INTO ingredients (id, name, unit, stock_quantity, critical_threshold, cost_per_unit)
       VALUES (gen_random_uuid(), 'LogConcIngredient', 'unit', 10, 0, 0)
       RETURNING id`
    )
    ingredientId = ing.rows[0].id

    const mi = await pool.query<{ id: string }>(
      `INSERT INTO menu_items (id, name, price, is_available)
       VALUES (gen_random_uuid(), 'LogConcDish', '8.00', true)
       RETURNING id`
    )
    menuItemId = mi.rows[0].id

    await pool.query(
      `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_used)
       VALUES ($1, $2, 1)`,
      [menuItemId, ingredientId]
    )

    // Seed: create a test order in ready_for_pickup status
    // customer_id is uuid type — use gen_random_uuid() since courier ids are text
    const orderResult = await pool.query<{ id: string }>(
      `INSERT INTO orders (id, customer_id, status, total_amount, delivery_address)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'ready_for_pickup', '8.00', '123 Test Street')
       RETURNING id`
    )
    orderId = orderResult.rows[0].id

    await pool.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_status)
       VALUES ($1, $2, 1, '8.00', 'ready')`,
      [orderId, menuItemId]
    )
  })

  afterAll(async () => {
    // Clean up in dependency order
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId])
    await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId])
    await pool.query(`DELETE FROM menu_item_ingredients WHERE menu_item_id = $1`, [menuItemId])
    await pool.query(`DELETE FROM menu_items WHERE id = $1`, [menuItemId])
    await pool.query(`DELETE FROM ingredients WHERE id = $1`, [ingredientId])
    await pool.query(`DELETE FROM "user" WHERE id IN ($1, $2)`, [courierAId, courierBId])
    await pool.end()
  })

  it('exactly one of two concurrent courier claims succeeds (LOGI-04)', async () => {
    // Fire both claims simultaneously
    const [resultA, resultB] = await Promise.all([
      claimOrderDirect(pool, orderId, courierAId),
      claimOrderDirect(pool, orderId, courierBId)
    ])

    const results = [resultA, resultB]
    const successes = results.filter(r => r.ok === true)
    const failures = results.filter(r => r.ok === false)

    // Exactly one winner
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    // Verify DB state: one courier_id set, status is picked_up
    const { rows } = await pool.query(
      `SELECT status, courier_id FROM orders WHERE id = $1`,
      [orderId]
    )
    expect(rows[0].status).toBe('picked_up')
    expect(rows[0].courier_id).not.toBeNull()
    // The winner must be one of our two test couriers
    expect([courierAId, courierBId]).toContain(rows[0].courier_id)
  })
})
