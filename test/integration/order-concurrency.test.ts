// test/integration/order-concurrency.test.ts
// CONS-03: Integration test for SELECT FOR UPDATE race condition.
// Proves that two concurrent POST /consumer/orders for the last stock unit
// result in exactly one success (200) and one failure (409 / ok: false).
//
// Skipped automatically when DATABASE_URL is not a real Neon/Postgres URL.
// To run manually: DATABASE_URL=<real-url> bun test test/integration/order-concurrency.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'

// Skip integration tests when DATABASE_URL is the placeholder (unit test environments)
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const isRealDb = (DATABASE_URL.includes('neon.tech') || DATABASE_URL.includes('postgres://'))
  && !DATABASE_URL.includes('placeholder')

// This test requires a live Neon database with real SELECT FOR UPDATE support.
// It is skipped in unit test environments where DATABASE_URL is not set.
// To run manually: DATABASE_URL=<real-url> bun test test/integration/order-concurrency.test.ts
const describeIfRealDb = isRealDb ? describe : describe.skip

describeIfRealDb('CONS-03: SELECT FOR UPDATE race condition', () => {
  let pool: Pool
  let menuItemId: string
  let ingredientId: string
  let customer1Id: string
  let customer2Id: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 10 })

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
    const { createOrder } = await import('../../src/plugins/consumer/service')

    const orderInput = [{ menuItemId, quantity: 1 }]

    // Fire both orders simultaneously
    const [result1, result2] = await Promise.all([
      createOrder(customer1Id, orderInput),
      createOrder(customer2Id, orderInput)
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
