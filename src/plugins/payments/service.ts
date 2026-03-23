// src/plugins/payments/service.ts
import Stripe from 'stripe'
import { Pool } from 'pg'
import { db } from '../../db/client'
import { orders } from '../../db/schema/orders'
import { eq, and } from 'drizzle-orm'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover'
})

// pg.Pool for transactional webhook processing — uses DATABASE_DIRECT_URL to bypass
// PgBouncer (transaction mode does not preserve row locks across queries)
const txPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 3
})

export { stripe }

export async function createPaymentIntent(orderId: string, customerId: string): Promise<
  | { ok: true; clientSecret: string }
  | { ok: false; error: string }
> {
  // Fetch order — must belong to customer and be in 'pending' status
  const [order] = await db
    .select({ id: orders.id, totalAmount: orders.totalAmount, status: orders.status, customerId: orders.customerId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1)

  if (!order) return { ok: false, error: 'ORDER_NOT_FOUND' }
  if (order.status !== 'pending') return { ok: false, error: 'ORDER_NOT_PENDING' }

  const amount = Math.round(Number(order.totalAmount) * 100)
  const currency = process.env.STRIPE_CURRENCY ?? 'ars'

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency,
    metadata: { orderId, customerId }
  })

  return { ok: true, clientSecret: paymentIntent.client_secret! }
}

export async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<
  | { ok: true; orderId: string }
  | { ok: false; error: 'ALREADY_PROCESSED' | 'ORDER_NOT_FOUND' | 'ORDER_NOT_PENDING' }
> {
  const orderId = paymentIntent.metadata.orderId
  if (!orderId) return { ok: false, error: 'ORDER_NOT_FOUND' }

  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    // Idempotency check: if stripePaymentIntentId already exists, this is a retry
    const { rows: existing } = await client.query(
      `SELECT id FROM payment_intents WHERE stripe_payment_intent_id = $1 LIMIT 1`,
      [paymentIntent.id]
    )
    if (existing.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'ALREADY_PROCESSED' }
    }

    // Insert payment record
    await client.query(
      `INSERT INTO payment_intents (order_id, stripe_payment_intent_id, status, idempotency_key)
       VALUES ($1, $2, 'paid', $3)`,
      [orderId, paymentIntent.id, paymentIntent.id]
    )

    // Update order status: only from 'pending' to 'confirmed'
    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [orderId]
    )

    if (rowCount === 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'ORDER_NOT_PENDING' }
    }

    // Notify consumer WebSocket channel
    await client.query(
      `SELECT pg_notify('flashshell_events', $1::text)`,
      [JSON.stringify({
        channel: `order:${orderId}`,
        event: 'order_confirmed',
        orderId,
        status: 'confirmed'
      })]
    )

    // Notify KDS — new confirmed order ready for kitchen
    await client.query(
      `SELECT pg_notify('flashshell_events', $1::text)`,
      [JSON.stringify({
        channel: 'kds',
        event: 'new_order',
        orderId
      })]
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
