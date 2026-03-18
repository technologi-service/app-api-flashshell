// src/plugins/payments/service.ts
import Stripe from 'stripe'
import { db } from '../../db/client'
import { orders } from '../../db/schema/orders'
import { eq, and } from 'drizzle-orm'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18'
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
