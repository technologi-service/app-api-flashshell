// test/integration/stock-trigger.test.ts
// CTRL-01: Integration test for stock deduction trigger (deduct_stock_on_confirm)
// CTRL-02: Integration test for low_stock_alert pg_notify when stock drops below threshold
//
// Uses pg.Pool + pg.Client on DATABASE_DIRECT_URL (not the pooler) to avoid
// Bun 1.3.9 mock.module() contamination and to support LISTEN/NOTIFY.
//
// Skipped automatically when DATABASE_DIRECT_URL/DATABASE_URL is not a real Postgres URL.
// To run manually: DATABASE_DIRECT_URL=<real-url> bun test test/integration/stock-trigger.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Pool, Client } from 'pg'

const DATABASE_DIRECT_URL = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? ''
const isRealDb =
  (DATABASE_DIRECT_URL.includes('neon.tech') || DATABASE_DIRECT_URL.includes('postgres://')) &&
  !DATABASE_DIRECT_URL.includes('placeholder')

const describeIfRealDb = isRealDb ? describe : describe.skip

// Fixed UUIDs for deterministic fixture data — avoids gen_random_uuid() for ON CONFLICT handling
const FIXTURE_INGREDIENT_ID = '11111111-1111-1111-1111-111111111101'
const FIXTURE_MENU_ITEM_ID = '22222222-2222-2222-2222-222222222201'
const FIXTURE_CUSTOMER_ID = '33333333-3333-3333-3333-333333333301'
const FIXTURE_ORDER_ID = '44444444-4444-4444-4444-444444444401'

const INITIAL_STOCK = 100
const QUANTITY_USED = 2.5
const ORDER_ITEM_QUANTITY = 2
// Expected stock after deduction: 100 - (2.5 * 2) = 95.0
const EXPECTED_STOCK_AFTER_DEDUCTION = 95.0

describeIfRealDb('CTRL-01 / CTRL-02: stock deduction trigger', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_DIRECT_URL, max: 5 })

    // Insert test customer into Better Auth user table
    await pool.query(
      `INSERT INTO "user" (id, email, name, created_at, updated_at)
       VALUES ($1, 'stocktrigger@test.invalid', 'StockTriggerTest', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [FIXTURE_CUSTOMER_ID]
    )

    // Insert test ingredient
    await pool.query(
      `INSERT INTO ingredients (id, name, unit, stock_quantity, critical_threshold, cost_per_unit)
       VALUES ($1, 'Flour', 'kg', $2, 10, 0.50)
       ON CONFLICT (id) DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity`,
      [FIXTURE_INGREDIENT_ID, INITIAL_STOCK]
    )

    // Insert test menu item
    await pool.query(
      `INSERT INTO menu_items (id, name, price, is_available)
       VALUES ($1, 'Pizza', '15.00', true)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [FIXTURE_MENU_ITEM_ID]
    )

    // Link ingredient to menu item (quantity_used = 2.5 per pizza)
    // Delete first for idempotency (no unique constraint on menu_item_ingredients)
    await pool.query(
      `DELETE FROM menu_item_ingredients WHERE menu_item_id = $1 AND ingredient_id = $2`,
      [FIXTURE_MENU_ITEM_ID, FIXTURE_INGREDIENT_ID]
    )
    await pool.query(
      `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_used)
       VALUES ($1, $2, $3)`,
      [FIXTURE_MENU_ITEM_ID, FIXTURE_INGREDIENT_ID, QUANTITY_USED]
    )

    // Insert test order with status='pending'
    await pool.query(
      `INSERT INTO orders (id, customer_id, status, total_amount, delivery_address)
       VALUES ($1, $2, 'pending', '15.00', 'Test St')
       ON CONFLICT (id) DO UPDATE SET status = 'pending'`,
      [FIXTURE_ORDER_ID, FIXTURE_CUSTOMER_ID]
    )

    // Insert order_items linking order to menu item (quantity = 2)
    // Delete first for idempotency (no unique constraint on order_items beyond PK)
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [FIXTURE_ORDER_ID])
    await pool.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_status)
       VALUES ($1, $2, $3, '15.00', 'pending')`,
      [FIXTURE_ORDER_ID, FIXTURE_MENU_ITEM_ID, ORDER_ITEM_QUANTITY]
    )
  })

  afterAll(async () => {
    // Clean up in FK dependency order
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [FIXTURE_ORDER_ID])
    await pool.query(`DELETE FROM orders WHERE id = $1`, [FIXTURE_ORDER_ID])
    await pool.query(`DELETE FROM menu_item_ingredients WHERE menu_item_id = $1`, [
      FIXTURE_MENU_ITEM_ID
    ])
    await pool.query(`DELETE FROM menu_items WHERE id = $1`, [FIXTURE_MENU_ITEM_ID])
    await pool.query(`DELETE FROM ingredients WHERE id = $1`, [FIXTURE_INGREDIENT_ID])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [FIXTURE_CUSTOMER_ID])
    await pool.end()
  })

  beforeEach(async () => {
    // Reset order status to pending and ingredient stock to initial value between tests
    await pool.query(`UPDATE orders SET status = 'pending' WHERE id = $1`, [FIXTURE_ORDER_ID])
    await pool.query(`UPDATE ingredients SET stock_quantity = $1 WHERE id = $2`, [
      INITIAL_STOCK,
      FIXTURE_INGREDIENT_ID
    ])
  })

  it('CTRL-01 — deducts stock when order transitions to confirmed', async () => {
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [FIXTURE_ORDER_ID])

    const { rows } = await pool.query<{ stock_quantity: string }>(
      `SELECT stock_quantity FROM ingredients WHERE id = $1`,
      [FIXTURE_INGREDIENT_ID]
    )

    expect(rows).toHaveLength(1)
    const stock = parseFloat(rows[0].stock_quantity)
    // 100 - (2.5 * 2) = 95.0
    expect(stock).toBe(EXPECTED_STOCK_AFTER_DEDUCTION)
  })

  it('CTRL-01 — does NOT double-deduct when confirmed order is updated again', async () => {
    // Confirm the order (triggers deduction: 100 -> 95)
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [FIXTURE_ORDER_ID])

    // Update confirmed order to another status (should NOT trigger deduction again)
    await pool.query(`UPDATE orders SET status = 'preparing' WHERE id = $1`, [FIXTURE_ORDER_ID])

    const { rows } = await pool.query<{ stock_quantity: string }>(
      `SELECT stock_quantity FROM ingredients WHERE id = $1`,
      [FIXTURE_INGREDIENT_ID]
    )

    expect(rows).toHaveLength(1)
    const stock = parseFloat(rows[0].stock_quantity)
    // Must still be 95.0 — not 90.0 (which would indicate double deduction)
    expect(stock).toBe(EXPECTED_STOCK_AFTER_DEDUCTION)
  })

  it('CTRL-02 — emits low_stock_alert when stock drops below critical_threshold', async () => {
    // Set stock to 12 — just above the critical_threshold of 10.
    // After deduction of 5 (2.5 * 2), stock becomes 7 which is < 10.
    await pool.query(`UPDATE ingredients SET stock_quantity = 12 WHERE id = $1`, [
      FIXTURE_INGREDIENT_ID
    ])

    const listenClient = new Client({ connectionString: DATABASE_DIRECT_URL })
    await listenClient.connect()
    await listenClient.query('LISTEN flashshell_events')

    const notificationPromise = new Promise<{
      channel: string
      event: string
      ingredientId?: string
      ingredientName?: string
      currentStock?: number
      criticalThreshold?: number
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for low_stock_alert notification (5s)'))
      }, 5000)

      listenClient.on('notification', (msg) => {
        if (!msg.payload) return
        try {
          const payload = JSON.parse(msg.payload)
          if (payload.event === 'low_stock_alert') {
            clearTimeout(timeout)
            resolve(payload)
          }
        } catch {
          // ignore parse errors
        }
      })
    })

    // Trigger the stock deduction — stock goes from 12 to 7, below threshold of 10
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [FIXTURE_ORDER_ID])

    const payload = await notificationPromise
    await listenClient.end()

    expect(payload.event).toBe('low_stock_alert')
    expect(payload.channel).toBe('control')
    expect(payload.ingredientName).toBe('Flour')
    expect(typeof payload.currentStock).toBe('number')
    expect(payload.currentStock).toBeLessThan(10)
  })

  it('trigger emits order_confirmed to control channel', async () => {
    const listenClient = new Client({ connectionString: DATABASE_DIRECT_URL })
    await listenClient.connect()
    await listenClient.query('LISTEN flashshell_events')

    const notificationPromise = new Promise<{
      channel: string
      event: string
      orderId?: string
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for order_confirmed notification (5s)'))
      }, 5000)

      listenClient.on('notification', (msg) => {
        if (!msg.payload) return
        try {
          const payload = JSON.parse(msg.payload)
          if (payload.event === 'order_confirmed') {
            clearTimeout(timeout)
            resolve(payload)
          }
        } catch {
          // ignore parse errors
        }
      })
    })

    // Trigger the status transition
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [FIXTURE_ORDER_ID])

    const payload = await notificationPromise
    await listenClient.end()

    expect(payload.event).toBe('order_confirmed')
    expect(payload.channel).toBe('control')
    expect(payload.orderId).toBe(FIXTURE_ORDER_ID)
  })
})
