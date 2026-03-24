// src/jobs/expire-orders.ts
// Background job: cancela órdenes pending que superaron su ventana de pago (30 min)
// y notifica al cliente vía pg_notify → WebSocket.
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 2
})

async function expireOrders(): Promise<void> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE orders
       SET status = 'cancelled', updated_at = NOW()
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at < NOW()
       RETURNING id`
    )

    for (const { id: orderId } of rows) {
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({
          channel: `order:${orderId}`,
          event: 'order_expired',
          orderId,
          reason: 'Tu pedido ha expirado. No se completó el pago en los 30 minutos disponibles. Puedes realizar un nuevo pedido cuando quieras.'
        })]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({
          channel: 'control',
          event: 'order_cancelled',
          orderId,
          reason: 'expired'
        })]
      )
    }

    if (rows.length > 0) {
      console.log(`[expire-orders] ${rows.length} orden(es) expirada(s) cancelada(s)`)
    }
  } catch (err) {
    console.error('[expire-orders] Error al procesar órdenes expiradas:', err)
  } finally {
    client.release()
  }
}

export function startExpireOrdersJob(intervalMs = 5 * 60 * 1000): void {
  // Ejecutar inmediatamente al arrancar para limpiar órdenes expiradas durante reinicios
  expireOrders()
  setInterval(expireOrders, intervalMs)
  console.log(`✓ Job expiración de órdenes activo (cada ${intervalMs / 1000 / 60} min)`)
}
