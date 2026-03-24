// src/plugins/payments/service.ts
import Stripe from 'stripe'
import { Pool } from 'pg'
import { db } from '../../db/client'
import { orders } from '../../db/schema/orders'
import { paymentIntents } from '../../db/schema/payments'
import { eq, and, not, inArray } from 'drizzle-orm'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover'
})

// Pool directo para operaciones transaccionales (webhook handler, handlePaymentFailed).
// DATABASE_DIRECT_URL evita PgBouncer, que no preserva locks entre queries.
const txPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 3
})

const MAX_PAYMENT_RETRIES = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function notifyOrderChannel(client: import('pg').PoolClient, payload: object) {
  await client.query(
    `SELECT pg_notify('flashshell_events', $1::text)`,
    [JSON.stringify(payload)]
  )
}

// ---------------------------------------------------------------------------
// createPaymentIntent
// Llamado por POST /consumer/orders/:id/pay
// ---------------------------------------------------------------------------

export async function createPaymentIntent(
  orderId: string,
  customerId: string
): Promise<
  | { ok: true; clientSecret: string }
  | { ok: false; error: 'ORDER_NOT_FOUND' | 'ORDER_NOT_PENDING' | 'ORDER_EXPIRED' | 'INSUFFICIENT_STOCK' }
> {
  // 1. Verificar que la orden existe, pertenece al cliente y está en pending
  const [order] = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      status: orders.status,
      customerId: orders.customerId,
      expiresAt: orders.expiresAt
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1)

  if (!order) return { ok: false, error: 'ORDER_NOT_FOUND' }
  if (order.status !== 'pending') return { ok: false, error: 'ORDER_NOT_PENDING' }
  if (order.expiresAt && new Date() > order.expiresAt) return { ok: false, error: 'ORDER_EXPIRED' }

  // 2. Re-validar stock en tiempo real (sin bloqueo — la verificación final con lock
  //    ocurre en el webhook para garantizar atomicidad)
  const { rows: stockRows } = await txPool.query<{
    stock_quantity: string
    order_quantity: string
    quantity_used: string
  }>(
    `SELECT i.stock_quantity, oi.quantity::text AS order_quantity, mii.quantity_used
     FROM order_items oi
     JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
     JOIN ingredients i ON i.id = mii.ingredient_id
     WHERE oi.order_id = $1`,
    [orderId]
  )

  const insufficientStock = stockRows.some(
    row => Number(row.stock_quantity) < Number(row.order_quantity) * Number(row.quantity_used)
  )
  if (insufficientStock) return { ok: false, error: 'INSUFFICIENT_STOCK' }

  // 3. Cancelar cualquier PaymentIntent activo previo para esta orden
  //    (evita que el cliente acumule intents abiertos en Stripe si llama /pay varias veces)
  const [existingPI] = await db
    .select({ id: paymentIntents.id, stripePaymentIntentId: paymentIntents.stripePaymentIntentId })
    .from(paymentIntents)
    .where(and(
      eq(paymentIntents.orderId, orderId),
      not(inArray(paymentIntents.status, ['succeeded', 'failed', 'canceled']))
    ))
    .limit(1)

  if (existingPI) {
    try {
      await stripe.paymentIntents.cancel(existingPI.stripePaymentIntentId)
    } catch {
      // El PI pudo haber expirado o cambiado de estado en Stripe — ignorar el error
    }
    await db
      .update(paymentIntents)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(eq(paymentIntents.id, existingPI.id))
  }

  // 4. Crear nuevo PaymentIntent en Stripe
  const amount = Math.round(Number(order.totalAmount) * 100) // centavos
  const currency = process.env.STRIPE_CURRENCY ?? 'eur'

  const pi = await stripe.paymentIntents.create({
    amount,
    currency,
    metadata: { orderId, customerId }
  })

  // 5. Registrar el PI en nuestra BD
  await db.insert(paymentIntents).values({
    orderId,
    stripePaymentIntentId: pi.id,
    status: 'requires_payment_method',
    idempotencyKey: pi.id
  })

  return { ok: true, clientSecret: pi.client_secret! }
}

// ---------------------------------------------------------------------------
// handlePaymentSucceeded
// Llamado por webhook payment_intent.succeeded
// ---------------------------------------------------------------------------

export async function handlePaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent
): Promise<
  | { ok: true; orderId: string }
  | { ok: false; error: 'ALREADY_PROCESSED' | 'ORDER_NOT_FOUND' | 'ORDER_NOT_PENDING' | 'INSUFFICIENT_STOCK' }
> {
  const orderId = paymentIntent.metadata.orderId
  if (!orderId) return { ok: false, error: 'ORDER_NOT_FOUND' }

  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    // Bloquear la fila del PI para idempotencia — previene procesamiento doble
    // ante reintentos concurrentes de Stripe
    const { rows: piRows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM payment_intents
       WHERE stripe_payment_intent_id = $1
       FOR UPDATE`,
      [paymentIntent.id]
    )

    if (piRows.length === 0) {
      // El PI no existe (webhook llegó antes de que createPaymentIntent guardara el registro).
      // Insertar ahora para continuar con el procesamiento.
      await client.query(
        `INSERT INTO payment_intents (order_id, stripe_payment_intent_id, status, idempotency_key)
         VALUES ($1, $2, 'requires_payment_method', $2)
         ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
        [orderId, paymentIntent.id]
      )
    } else if (piRows[0].status === 'succeeded') {
      await client.query('ROLLBACK')
      return { ok: false, error: 'ALREADY_PROCESSED' }
    }

    // Bloquear ingredientes de esta orden para evitar condición de carrera de stock
    await client.query(
      `SELECT i.id FROM ingredients i
       WHERE i.id IN (
         SELECT mii.ingredient_id FROM menu_item_ingredients mii
         JOIN order_items oi ON oi.menu_item_id = mii.menu_item_id
         WHERE oi.order_id = $1
       )
       FOR UPDATE`,
      [orderId]
    )

    // Leer stock actual (ya con lock)
    const { rows: ingredientRows } = await client.query<{
      ingredient_id: string
      stock_quantity: string
      order_quantity: string
      quantity_used: string
    }>(
      `SELECT
         mii.ingredient_id,
         i.stock_quantity,
         oi.quantity::text AS order_quantity,
         mii.quantity_used
       FROM order_items oi
       JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
       JOIN ingredients i ON i.id = mii.ingredient_id
       WHERE oi.order_id = $1`,
      [orderId]
    )

    const insufficientStock = ingredientRows.some(
      row => Number(row.stock_quantity) < Number(row.order_quantity) * Number(row.quantity_used)
    )

    if (insufficientStock) {
      // Stock agotado por una orden concurrente — cancelar y reembolsar automáticamente
      await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [orderId]
      )
      await client.query(
        `UPDATE payment_intents SET status = 'succeeded', updated_at = NOW()
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntent.id]
      )
      await notifyOrderChannel(client, {
        channel: `order:${orderId}`,
        event: 'order_cancelled',
        orderId,
        reason: 'Uno o más ingredientes de tu pedido se han agotado. Recibirás un reembolso completo en breve.'
      })
      await notifyOrderChannel(client, {
        channel: 'control',
        event: 'order_cancelled',
        orderId,
        reason: 'insufficient_stock'
      })
      await client.query('COMMIT')

      // Reembolso fuera de la transacción (llamada externa a Stripe)
      try {
        await stripe.refunds.create({ payment_intent: paymentIntent.id })
      } catch (refundErr) {
        // Log — el reembolso puede gestionarse manualmente desde el dashboard de Stripe
        console.error(`[payments] Refund failed for PI ${paymentIntent.id}:`, refundErr)
      }

      return { ok: false, error: 'INSUFFICIENT_STOCK' }
    }

    // El trigger trg_deduct_stock_on_confirm (migration 0004) descuenta el stock
    // y emite low_stock_alert vía pg_notify cuando la orden pasa a 'confirmed'.
    // No se decrementa aquí para evitar doble deducción.

    // Confirmar orden: solo desde 'pending' — protección extra ante estados inesperados
    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [orderId]
    )

    if (rowCount === 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'ORDER_NOT_PENDING' }
    }

    // Marcar PI como succeeded
    await client.query(
      `UPDATE payment_intents SET status = 'succeeded', updated_at = NOW()
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntent.id]
    )

    // Notificar al cliente que su orden está confirmada
    await notifyOrderChannel(client, {
      channel: `order:${orderId}`,
      event: 'order_confirmed',
      orderId,
      status: 'confirmed'
    })

    // Notificar a la cocina (KDS) que hay una nueva orden confirmada
    await notifyOrderChannel(client, {
      channel: 'kds',
      event: 'new_order',
      orderId
    })

    await client.query('COMMIT')
    return { ok: true, orderId }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// handlePaymentFailed
// Llamado por webhook payment_intent.payment_failed
// ---------------------------------------------------------------------------

export async function handlePaymentFailed(
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const orderId = paymentIntent.metadata.orderId
  if (!orderId) return

  const failureReason =
    paymentIntent.last_payment_error?.message ?? 'Pago rechazado por la entidad bancaria'

  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    // Actualizar estado del PI fallido
    await client.query(
      `UPDATE payment_intents
       SET status = 'failed', failure_reason = $1, updated_at = NOW()
       WHERE stripe_payment_intent_id = $2`,
      [failureReason, paymentIntent.id]
    )

    // Contar intentos fallidos totales para esta orden
    const { rows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM payment_intents
       WHERE order_id = $1 AND status = 'failed'`,
      [orderId]
    )
    const failureCount = rows[0].count

    if (failureCount >= MAX_PAYMENT_RETRIES) {
      // Cancelar la orden tras agotar los reintentos
      await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [orderId]
      )
      await notifyOrderChannel(client, {
        channel: `order:${orderId}`,
        event: 'order_cancelled',
        orderId,
        reason: `Tu pedido ha sido cancelado tras ${MAX_PAYMENT_RETRIES} intentos de pago fallidos. Motivo: ${failureReason}`
      })
      await notifyOrderChannel(client, {
        channel: 'control',
        event: 'order_cancelled',
        orderId,
        reason: 'max_payment_retries'
      })
    } else {
      const attemptsRemaining = MAX_PAYMENT_RETRIES - failureCount
      await notifyOrderChannel(client, {
        channel: `order:${orderId}`,
        event: 'payment_failed',
        orderId,
        reason: failureReason,
        attemptsRemaining,
        message: `El pago no se ha podido procesar. Te quedan ${attemptsRemaining} intento${attemptsRemaining === 1 ? '' : 's'}.`
      })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// handlePaymentCanceled
// Llamado por webhook payment_intent.canceled
// ---------------------------------------------------------------------------

export async function handlePaymentCanceled(
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const orderId = paymentIntent.metadata.orderId
  if (!orderId) return

  // Marcar PI como cancelado
  await db
    .update(paymentIntents)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(paymentIntents.stripePaymentIntentId, paymentIntent.id))

  // Cancelar la orden si aún está en pending
  const client = await txPool.connect()
  try {
    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [orderId]
    )

    if (rowCount && rowCount > 0) {
      await notifyOrderChannel(client, {
        channel: `order:${orderId}`,
        event: 'order_cancelled',
        orderId,
        reason: 'El pago fue cancelado.'
      })
      await notifyOrderChannel(client, {
        channel: 'control',
        event: 'order_cancelled',
        orderId,
        reason: 'payment_canceled'
      })
    }
  } finally {
    client.release()
  }
}
