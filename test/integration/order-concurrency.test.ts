// test/integration/order-concurrency.test.ts
// CONS-03: Integration test for SELECT FOR UPDATE race condition.
// Proves that two concurrent orders for the last stock unit result in exactly
// one success and one failure — the SELECT FOR UPDATE serializes concurrent stock reservations.
//
// This test uses direct pg.Pool queries to avoid contamination from mock.module() calls
// in unit test files (Bun 1.3.9 shares module registry across test files in the same run).
//
// Skipped automatically when DATABASE_DIRECT_URL/DATABASE_URL is not a real Neon/Postgres URL.
// To run manually: DATABASE_DIRECT_URL=<real-url> bun test test/integration/order-concurrency.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'

// Skip integration tests when DATABASE_URL is the placeholder (unit test environments)
const DATABASE_DIRECT_URL = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? ''
const isRealDb = (DATABASE_DIRECT_URL.includes('neon.tech') || DATABASE_DIRECT_URL.includes('postgres://'))
  && !DATABASE_DIRECT_URL.includes('placeholder')

// This test requires a live Neon database with real SELECT FOR UPDATE support.
// Uses DATABASE_DIRECT_URL (not the pooler) to ensure SELECT FOR UPDATE serializes correctly.
const describeIfRealDb = isRealDb ? describe : describe.skip

/**
 * Simulates createOrder() transactional logic directly via pg.Pool to avoid
 * mock.module() contamination from unit test files running in the same Bun process.
 * This mirrors the exact SELECT FOR UPDATE logic in src/plugins/consumer/service.ts.
 */
async function createOrderDirect(
  pool: Pool,
  customerId: string,
  menuItemId: string
): Promise<{ ok: true; orderId: string } | { ok: false; failures: string[] }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock ingredient rows for this menu item (same logic as service.ts)
    await client.query(
      `SELECT i.id FROM ingredients i
       WHERE i.id IN (
         SELECT mii.ingredient_id FROM menu_item_ingredients mii
         WHERE mii.menu_item_id = $1
       )
       FOR UPDATE`,
      [menuItemId]
    )

    // Read menu item and ingredient stock (ingredients already locked above)
    const { rows } = await client.query<{
      is_available: boolean
      stock_quantity: string | null
      quantity_used: string | null
      ingredient_id: string | null
      price: string
    }>(
      `SELECT mi.is_available, mi.price,
              i.id AS ingredient_id, i.stock_quantity, mii.quantity_used
       FROM menu_items mi
       LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
       LEFT JOIN ingredients i ON i.id = mii.ingredient_id
       WHERE mi.id = $1`,
      [menuItemId]
    )

    if (!rows[0] || !rows[0].is_available) {
      await client.query('ROLLBACK')
      return { ok: false, failures: [menuItemId] }
    }

    const ing = rows[0]
    if (ing.ingredient_id && ing.stock_quantity !== null && ing.quantity_used !== null) {
      if (Number(ing.stock_quantity) < 1 * Number(ing.quantity_used)) {
        await client.query('ROLLBACK')
        return { ok: false, failures: [menuItemId] }
      }

      // Decrement stock
      await client.query(
        `UPDATE ingredients SET stock_quantity = stock_quantity - $1 WHERE id = $2`,
        [ing.quantity_used, ing.ingredient_id]
      )
    }

    // Insert order
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (customer_id, status, total_amount)
       VALUES ($1, 'confirmed', $2)
       RETURNING id`,
      [customerId, ing.price]
    )
    const orderId = orderRows[0].id

    await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_status)
       VALUES ($1, $2, 1, $3, 'pending')`,
      [orderId, menuItemId, ing.price]
    )

    await client.query('COMMIT')
    return { ok: true, orderId }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

describeIfRealDb('CONS-03: SELECT FOR UPDATE race condition', () => {
  let pool: Pool
  let menuItemId: string
  let ingredientId: string
  let customer1Id: string
  let customer2Id: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_DIRECT_URL, max: 10 })

    // Seed: create two test customers (use Better Auth user table)
    // ON CONFLICT DO UPDATE ensures idempotent setup even if a prior run left data behind
    const c1 = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, email, name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'conctest1@test.invalid', 'ConcTest1', NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    customer1Id = c1.rows[0].id

    const c2 = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, email, name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'conctest2@test.invalid', 'ConcTest2', NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    customer2Id = c2.rows[0].id

    // Seed: create one ingredient with stock=1
    const ing = await pool.query<{ id: string }>(
      `INSERT INTO ingredients (id, name, unit, stock_quantity, critical_threshold, cost_per_unit)
       VALUES (gen_random_uuid(), 'TestIngredient', 'unit', 1, 0, 0)
       RETURNING id`
    )
    ingredientId = ing.rows[0].id

    // Seed: create one menu item linked to that ingredient (1 unit used per menu item)
    const mi = await pool.query<{ id: string }>(
      `INSERT INTO menu_items (id, name, price, is_available)
       VALUES (gen_random_uuid(), 'TestDish', '5.00', true)
       RETURNING id`
    )
    menuItemId = mi.rows[0].id

    await pool.query(
      `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_used)
       VALUES ($1, $2, 1)`,
      [menuItemId, ingredientId]
    )
  })

  afterAll(async () => {
    // Clean up seeded data — delete in dependency order to avoid FK violations
    // order_items -> orders -> menu_items -> menu_item_ingredients -> ingredients
    await pool.query(
      `DELETE FROM order_items WHERE order_id IN (
         SELECT id FROM orders WHERE customer_id IN ($1, $2)
       )`,
      [customer1Id, customer2Id]
    )
    await pool.query(
      `DELETE FROM orders WHERE customer_id IN ($1, $2)`,
      [customer1Id, customer2Id]
    )
    await pool.query(`DELETE FROM menu_item_ingredients WHERE menu_item_id = $1`, [menuItemId])
    await pool.query(`DELETE FROM menu_items WHERE id = $1`, [menuItemId])
    await pool.query(`DELETE FROM ingredients WHERE id = $1`, [ingredientId])
    await pool.query(`DELETE FROM "user" WHERE id IN ($1, $2)`, [customer1Id, customer2Id])
    await pool.end()
  })

  it('exactly one of two concurrent orders for the last stock unit succeeds', async () => {
    // Fire both orders simultaneously using direct pg transactions
    // (mirrors createOrder() logic from service.ts without importing the mocked module)
    const [result1, result2] = await Promise.all([
      createOrderDirect(pool, customer1Id, menuItemId),
      createOrderDirect(pool, customer2Id, menuItemId)
    ])

    const successes = [result1, result2].filter(r => r.ok === true)
    const failures = [result1, result2].filter(r => r.ok === false)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    // Failure should identify the menuItemId as the failing item
    const failure = failures[0] as Extract<typeof result1, { ok: false }>
    expect(failure.failures).toContain(menuItemId)
  })
})
