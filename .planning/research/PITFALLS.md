# Domain Pitfalls

**Domain:** Dark Kitchen Backend — Bun + Elysia + Neon (PostgreSQL serverless)
**Project:** FlashShell Engine
**Researched:** 2026-03-15
**Confidence:** HIGH for PostgreSQL/concurrency pitfalls (official docs verified). MEDIUM for Neon-specific serverless behavior (training data + partial live verification). HIGH for Bun WebSocket behavior (official Bun docs verified).

---

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or production outages in dark kitchen backends.

---

### Pitfall 1: Race Condition en Stock — Ventas Simultáneas sin Locking

**What goes wrong:**
Dos pedidos llegan simultáneamente. Ambas transacciones leen `quantity = 1` para el mismo plato. Ambas proceden, ambas decrementan. El stock queda en `-1`. El plato se vende dos veces.

Este es el "lost update" problem. PostgreSQL's default isolation level is `READ COMMITTED`, which does NOT prevent this anomaly. Each transaction gets a fresh snapshot at the start of each command, so two concurrent reads both see `quantity = 1` before either write commits.

**Why it happens:**
```sql
-- Transaction A and B run concurrently:
-- Both read: SELECT quantity FROM menu_items WHERE id = 42;  → returns 1
-- Both check: 1 >= 1 → proceed
-- Both write: UPDATE menu_items SET quantity = quantity - 1 WHERE id = 42;
-- Final state: quantity = -1
-- READ COMMITTED does NOT block this.
```

**Consequences:**
- Negative stock — platos vendidos que no pueden prepararse
- Chef recibe pedido que no tiene ingredientes
- Reembolso obligatorio al cliente → pérdida de confianza
- Inconsistencia financiera en Flash-Control (stock reportado vs. stock real)

**Prevention:**
Use `SELECT ... FOR UPDATE` within a transaction to lock the row before checking and decrementing:

```sql
BEGIN;
  SELECT quantity FROM menu_items WHERE id = $1 FOR UPDATE;
  -- Row is now locked. Concurrent transaction blocks here until this one commits.
  -- Validate quantity >= requested_amount in application code.
  UPDATE menu_items SET quantity = quantity - $2 WHERE id = $1;
COMMIT;
```

For orders with multiple items, always lock rows in a consistent order (by `menu_item_id` ASC) to prevent deadlocks:

```sql
BEGIN;
  SELECT id, quantity FROM menu_items
  WHERE id = ANY($1::int[])
  ORDER BY id  -- consistent lock order prevents deadlocks
  FOR UPDATE;
  -- Validate each item has sufficient quantity
  UPDATE menu_items SET quantity = quantity - $amount WHERE id = $item_id;
  -- ... repeat for each item
COMMIT;
```

**Alternative:** Use `UPDATE ... WHERE quantity >= requested AND RETURNING quantity`. If no rows returned, the stock was insufficient. This avoids a separate SELECT but loses the ability to check mid-transaction.

**Detection (warning signs):**
- `quantity` column going negative in production
- Chef reports "I got an order for something we don't have"
- Metrics show duplicate order pairs for same menu item in narrow time windows

**Phase:** Flash-Consumer (pedidos) + Flash-Control (stock). Must be implemented in the same phase where order creation is built.

**Sources:** PostgreSQL transaction isolation docs (official, verified live). SERIALIZABLE isolation level would also prevent this but adds overhead and requires retry logic — `SELECT FOR UPDATE` is the right tool for this specific case.

---

### Pitfall 2: LISTEN/NOTIFY Incompatible con Connection Pooler

**What goes wrong:**
Se usa el pooled connection URL de Neon para la conexión de `LISTEN`. El pooler (PgBouncer-based) rota conexiones entre requests. Cuando la conexión es devuelta al pool, **PostgreSQL automáticamente elimina todos los registros de LISTEN para esa sesión**. El listener queda silencioso sin error visible.

**Why it happens:**
`LISTEN` state is session-scoped in PostgreSQL. The official documentation states: "A session's listen registrations are automatically cleared when the session ends." In a connection pool, "session ends" happens every time PgBouncer reassigns the connection to a different client. The Neon pooled endpoint (port 5432 via pooler) uses transaction-mode pooling, which means the physical connection can be reassigned between requests.

Additionally, PostgreSQL explicitly states: "A transaction that has executed `LISTEN` cannot be prepared for two-phase commit" — further evidence that LISTEN is fundamentally incompatible with pooled connection patterns.

**Consequences:**
- Chefs dejan de recibir notificaciones de pedidos nuevos — silenciosamente
- No hay error en los logs, la conexión sigue "activa"
- Pedidos se acumulan sin que la cocina los vea
- El sistema parece estar funcionando desde el cliente; solo falla en el KDS

**Prevention:**
Use the **direct (non-pooled) connection URL** for the LISTEN connection. Neon provides both a pooled URL (via the pooler) and a direct URL. The LISTEN connection must use the direct URL and must be a **persistent, dedicated connection** — never returned to a pool.

```typescript
// WRONG — pooled connection, LISTEN will silently break
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect(); // This connection may be rotated
await client.query('LISTEN order_events');

// CORRECT — dedicated direct connection for LISTEN only
import { Client } from '@neondatabase/serverless';

const listenerClient = new Client({
  connectionString: process.env.DATABASE_DIRECT_URL, // direct URL, not pooler
});
await listenerClient.connect();
await listenerClient.query('LISTEN order_events');
await listenerClient.query('LISTEN kds_events');
// This client is NEVER released. It lives for the process lifetime.
listenerClient.on('notification', (msg) => {
  // broadcast to WebSocket clients
});
```

**Also critical:** Reconnect the listener if the connection drops (e.g., Neon scale-to-zero, network interruption):

```typescript
listenerClient.on('error', async (err) => {
  logger.error({ err }, 'LISTEN connection lost, reconnecting...');
  await reconnectWithBackoff();
});
```

**Detection (warning signs):**
- New orders are visible in DB but chefs don't see them on KDS
- `pg_listening_channels()` on the listener connection returns empty array after some time
- The listener process is alive but `notification` events stop firing

**Phase:** Flash-KDS — must be the very first implementation task before any real-time broadcasting logic is written. Getting this wrong means rebuilding the entire real-time layer.

**Sources:** PostgreSQL LISTEN docs (official, live verified). Neon connection pooler behavior inferred from PgBouncer transaction mode semantics (MEDIUM confidence — architectural pattern confirmed, Neon-specific behavior training data).

---

### Pitfall 3: Inconsistencia Pago → Pedido (Doble Cobro o Pedido Sin Pago)

**What goes wrong:**
Two failure modes exist:

1. **Doble cobro:** El cliente hace click en "Pagar" dos veces (o la red retransmite la request). Se crean dos pagos y dos pedidos para la misma compra.
2. **Pedido sin pago:** El pago es procesado por MercadoPago pero la request al backend falla después del cobro (timeout, crash). El dinero sale pero el pedido no existe en el sistema.

**Why it happens:**
Without idempotency keys, payment processors accept duplicate calls. Without transactional coupling between payment confirmation and order creation, network failures between the two operations leave the system in a split state.

**Consequences:**
- Cliente cobrado dos veces → reembolso + pérdida de confianza + disputa
- Pedido fantasma: dinero cobrado, cocina no recibe nada, cliente espera
- Flash-Control reporta más ingresos de los que corresponden

**Prevention:**
Three-layer defense:

**Layer 1 — Idempotency key on payment call:**
```typescript
// Generate client-side idempotency key (UUID tied to cart session)
const idempotencyKey = `order-${userId}-${cartId}-${timestamp}`;

// Pass to MercadoPago
const payment = new Payment(mpClient);
await payment.create({
  body: { ... },
  requestOptions: { idempotencyKey }, // MP deduplicates on this key
});
```

**Layer 2 — Unique constraint on external payment reference:**
```sql
-- Prevent duplicate order creation from same payment
ALTER TABLE orders ADD CONSTRAINT uq_orders_payment_ref
  UNIQUE (external_payment_id);
```

**Layer 3 — Webhook-driven order creation (preferred pattern):**
Do NOT create the order in the same HTTP request that initiates payment. Instead:
1. HTTP request creates a `payment_intent` record (status: `pending`)
2. MercadoPago calls your webhook on payment success
3. Webhook handler creates the order transactionally inside the same DB operation as marking the payment_intent as `processed`

```sql
BEGIN;
  UPDATE payment_intents
    SET status = 'processed', processed_at = NOW()
    WHERE external_id = $1 AND status = 'pending'
    RETURNING id;  -- If no rows returned → already processed, skip

  INSERT INTO orders (...) VALUES (...);  -- Only runs if UPDATE above succeeded
COMMIT;
```

This pattern makes the webhook handler idempotent: if MercadoPago retries the webhook, the `status = 'pending'` check prevents duplicate order creation.

**Detection (warning signs):**
- `payment_intents` table has rows in `pending` state older than 5 minutes (payment webhook never arrived or failed)
- `orders` table has two rows referencing the same `external_payment_id`
- Customer support receives "I was charged but no order appeared" reports

**Phase:** Flash-Consumer — payments integration phase. Must not be prototyped without idempotency from day one.

**Sources:** MercadoPago v2 SDK docs (training data, MEDIUM confidence). Idempotency pattern is industry-standard; webhook-first order creation is the recommended architecture for payment webhooks regardless of processor.

---

### Pitfall 4: GPS — Tabla Bloat por Actualizaciones de Alta Frecuencia

**What goes wrong:**
El repartidor envía coordenadas cada 5 segundos. Con 10 repartidores activos, eso son 120 UPDATEs por minuto en la tabla `courier_location`. PostgreSQL's MVCC creates a **new row version for every UPDATE** — the old version becomes a "dead tuple". Autovacuum eventually reclaims space, but if GPS updates are frequent enough, dead tuples accumulate faster than autovacuum runs, causing:

1. Table bloat (tabla crece en disco sin datos nuevos)
2. Index bloat (índices incluyen punteros a dead tuples)
3. Sequential scans become slower as pages fill with dead rows
4. If Neon's autovacuum is throttled (serverless behavior), bloat can persist for extended periods

**Why it happens:**
PostgreSQL docs state: "An UPDATE or DELETE of a row does not immediately remove the old version of the row. This approach is necessary to gain the benefits of MVCC." Every GPS coordinate update creates one dead tuple in the `courier_location` table. At 120 updates/min per courier, a 10-courier operation creates 1,200 dead tuples/minute on a small table (one row per courier).

**Consequences:**
- GPS location queries slow down over time in production (table scans hit dead pages)
- Disk usage grows unexpectedly on Neon (affects storage billing)
- If Neon scales to zero during a quiet period, next startup has accumulated bloat

**Prevention:**
Three mitigations:

**1. Reduce write frequency — don't persist every GPS tick:**
```typescript
// Only write to DB every Nth update; use in-memory state for intermediate ticks
let updateCount = 0;
onGpsMessage(coords) {
  updateCount++;
  broadcastToClients(coords); // always broadcast via WebSocket
  if (updateCount % 6 === 0) { // write every 30s (6 × 5s interval)
    await db.update(courierLocation)
      .set({ lat: coords.lat, lng: coords.lng, updated_at: new Date() })
      .where(eq(courierLocation.courierId, courierId));
  }
}
```

**2. Configure autovacuum more aggressively for the GPS table:**
```sql
ALTER TABLE courier_location SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- vacuum at 1% dead tuples (default: 20%)
  autovacuum_analyze_scale_factor = 0.01
);
```

**3. Consider HOT (Heap Only Tuple) updates by not indexing frequently-updated columns:**
If `lat`/`lng` columns are not indexed, PostgreSQL can use HOT updates which do not add index entries for each new version — dramatically reducing index bloat. Only index columns used for filtering (e.g., `courier_id`), not the coordinate values themselves.

**Note on PostGIS:** If PostGIS is enabled and coordinates are stored as `GEOMETRY` type with a spatial index, the index is updated on every write. PostGIS GiST indexes are not HOT-eligible. For the current-position use case, storing as plain `NUMERIC(10,7)` columns for lat/lng is preferable to a spatial column — simpler, HOT-eligible, and sufficient for "show the dot on the map."

**Detection (warning signs):**
- `SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'courier_location'` grows continuously
- `courier_location` table size in Neon storage dashboard grows faster than the number of active couriers
- GPS queries show increasing latency over time in production

**Phase:** Flash-Logistics — GPS storage strategy must be decided at schema design time. Retrofitting HOT eligibility (removing indexes from coordinate columns) after data is in production requires index drops and potential application changes.

**Sources:** PostgreSQL MVCC docs and autovacuum docs (official, live verified). HOT update behavior (training data, HIGH confidence — well-documented PostgreSQL internals).

---

### Pitfall 5: Neon Scale-to-Zero Cold Start Rompe el LISTEN Listener

**What goes wrong:**
Neon scales the database to zero after inactivity (default: 5 minutes on free tier). When this happens:
1. The persistent LISTEN connection is severed (TCP drop)
2. On the next request, Neon wakes up (300–500ms cold start)
3. The LISTEN client is in an error/disconnected state
4. If reconnection is not automatic, the system silently loses all real-time notifications until the process is restarted

The dangerous scenario: The kitchen closes at 11pm. Neon scales to zero at 11:05pm. At 11:30pm, a late order comes in. Neon wakes up for the HTTP request (order creation succeeds), but the LISTEN connection is still dead. The `NOTIFY` fires but nobody receives it. The chef never sees the order on KDS.

**Why it happens:**
Neon's scale-to-zero is a network-level TCP reset of all connections to the PostgreSQL instance. Long-lived connections (like a LISTEN client) are not gracefully closed — the underlying TCP connection is simply reset. The Neon serverless driver's `Client` (or `pg.Client`) will eventually detect this but may not automatically reconnect without explicit error handling.

**Consequences:**
- Silent notification loss (most dangerous — no error, no alert)
- Orders received after a Neon wake-up but before listener reconnects are missed by chef
- The 500ms order-to-KDS requirement becomes impossible after any idle period

**Prevention:**

**1. Implement supervised reconnection with exponential backoff:**
```typescript
async function createListenerConnection(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });

  client.on('error', async (err) => {
    logger.error({ err }, 'LISTEN client error');
    await reconnect();
  });

  client.on('end', async () => {
    logger.warn('LISTEN client disconnected, reconnecting...');
    await reconnect();
  });

  await client.connect();
  await client.query('LISTEN order_events');
  await client.query('LISTEN kds_events');
  return client;
}

let reconnectAttempts = 0;
async function reconnect() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000); // max 30s
  reconnectAttempts++;
  await new Promise(r => setTimeout(r, delay));
  listenerClient = await createListenerConnection();
  reconnectAttempts = 0; // reset on successful reconnect
}
```

**2. Consider disabling scale-to-zero for production:**
Neon allows disabling scale-to-zero on paid plans. For a dark kitchen operating during business hours (12pm–11pm), the persistent compute cost is justified by eliminating cold start disruptions entirely.

**3. Keepalive queries:**
Send a `SELECT 1` every 60 seconds on the LISTEN connection to prevent idle TCP timeouts at the network layer (not scale-to-zero, but prevents NAT/firewall drops):
```typescript
setInterval(() => {
  listenerClient.query('SELECT 1').catch(err => logger.warn({ err }, 'Keepalive failed'));
}, 60_000);
```

**Detection (warning signs):**
- Logs show "LISTEN client disconnected" without subsequent "reconnected successfully"
- Monitoring: track last time a `notification` event fired vs. last time an order was created
- Alert if `notification` count and `order` creation count diverge by more than N minutes

**Phase:** Flash-KDS infrastructure setup. Reconnection logic must be part of the initial LISTEN implementation — retrofitting it after a production incident is reactive, not proactive.

**Sources:** Neon scale-to-zero behavior (training data, MEDIUM confidence). PostgreSQL connection drop behavior on TCP reset (high confidence — standard networking behavior). Reconnection pattern is industry-standard for long-lived DB connections.

---

### Pitfall 6: Auth Multirol — Un Repartidor Accede a Pedidos de Otro

**What goes wrong:**
The Clerk-based auth sets `role = "delivery"` on the JWT claim. The API correctly checks that the user is a delivery person. But the query fetches orders by status (`ready_for_pickup`) without filtering by `assigned_courier_id = current_user_id`. Any delivery person can see — and potentially claim — orders assigned to other couriers.

More dangerous variant: a `delivery` role user crafts a request with an order ID belonging to another courier and calls `PATCH /orders/:id/status` to mark it as "delivered". The system accepts it because the role check passes.

**Why it happens:**
Role-based authorization (`"delivery" can call this endpoint`) and ownership-based authorization (`this delivery person can only modify their own orders`) are different checks. Most initial implementations only implement the role check, forgetting the ownership check.

**Consequences:**
- Courier B marks Courier A's order as delivered (intentional fraud or accidental tap)
- Customer sees "delivered" but never received the order
- Financial reconciliation in Flash-Control is incorrect
- In a multi-courier operation, couriers can see each others' full order history (privacy violation)

**Prevention:**
**Always enforce both role AND ownership in every handler:**

```typescript
// WRONG: only checks role
.get('/orders/my-deliveries', async ({ user }) => {
  return db.select().from(orders)
    .where(eq(orders.status, 'ready_for_pickup')); // ALL pending orders — wrong
}, { beforeHandle: requireRole('delivery') })

// CORRECT: role + ownership filter
.get('/orders/my-deliveries', async ({ user }) => {
  return db.select().from(orders)
    .where(and(
      eq(orders.status, 'ready_for_pickup'),
      eq(orders.assignedCourierId, user.id) // Only this courier's orders
    ));
}, { beforeHandle: requireRole('delivery') })

// CORRECT: also validate ownership on mutations
.patch('/orders/:id/status', async ({ user, params, body }) => {
  const order = await db.query.orders.findFirst({
    where: and(
      eq(orders.id, params.id),
      eq(orders.assignedCourierId, user.id) // Must own this order
    )
  });
  if (!order) throw new NotFoundError('Order not found'); // Don't reveal existence
  // ... update status
}, { beforeHandle: requireRole('delivery') })
```

**For customers — same pattern:**
```typescript
// Customer can only see their own orders
.get('/orders/:id', async ({ user, params }) => {
  const order = await db.query.orders.findFirst({
    where: and(
      eq(orders.id, params.id),
      eq(orders.customerId, user.id) // Must own this order
    )
  });
  if (!order) throw new NotFoundError(); // 404, not 403 (don't reveal it exists)
```

**Optional defense-in-depth:** PostgreSQL Row Level Security (RLS). However, RLS has its own pitfalls (see Minor Pitfalls below) and adds complexity. For v1, application-level ownership checks in every query are sufficient and more auditable.

**Detection (warning signs):**
- Review all `delivery` role endpoints: does every query include `WHERE assigned_courier_id = $current_user`?
- Review all `customer` role endpoints: does every query include `WHERE customer_id = $current_user`?
- Any endpoint that fetches by `status` alone without a user filter is a potential exposure

**Phase:** Every module that introduces user-facing queries. Build the ownership check pattern as a shared utility at project foundation (Phase 1 / auth setup) so all subsequent modules use it consistently.

**Sources:** This is a fundamental authorization pattern (IDOR — Insecure Direct Object Reference). Industry-standard prevention strategies, training data, HIGH confidence.

---

## Moderate Pitfalls

---

### Pitfall 7: WebSocket Drop Sin Estado de Recuperación

**What goes wrong:**
A chef's browser loses the WebSocket connection (network hiccup, browser tab sleep, mobile network switch). During the disconnection window, 2 orders arrive. The reconnection succeeds. The chef's KDS shows the pre-disconnect state — the 2 orders are silently missing.

Bun's WebSocket `idleTimeout` defaults to 120 seconds — any connection silent for 2 minutes is forcibly closed. Mobile connections to a kitchen display tablet can go silent during low activity.

**Prevention:**

1. **Server-side: always send full pending state on WebSocket connect/reconnect:**
```typescript
websocket: {
  open(ws) {
    const role = ws.data.role;
    if (role === 'chef') {
      // Immediately send current pending orders on connect
      const pending = await db.select().from(orders)
        .where(eq(orders.status, 'pending'));
      ws.send(JSON.stringify({ type: 'SYNC_STATE', orders: pending }));
    }
    ws.subscribe(`kitchen-events`);
  }
}
```

2. **Client-side: implement automatic reconnect with state sync request**
3. **Configure `idleTimeout` explicitly** — for KDS (always-on display), set a longer timeout or implement client-side ping:
```typescript
websocket: {
  idleTimeout: 300, // 5 minutes instead of default 120s
}
```

**Phase:** Flash-KDS. Must be designed alongside the initial WebSocket implementation.

---

### Pitfall 8: Neon Connection Pool Exhaustion Under Burst Load

**What goes wrong:**
Dark kitchens have bursty traffic — the lunch rush generates 20x normal request rate in 5 minutes. If the Neon connection pool is exhausted (max connections reached), new requests get `connection timeout` errors rather than being queued gracefully.

Neon free tier allows approximately 100 connections. Neon's pooler (PgBouncer) in transaction mode can multiplex many application connections over few database connections, but if every request holds a connection longer than necessary (e.g., awaiting user input in a transaction, or not releasing connections promptly), pool exhaustion occurs.

**Prevention:**

1. **Use the Neon serverless pooler URL** for all regular queries (not LISTEN):
```typescript
// STACK.md already recommends this pattern:
// DATABASE_URL → pooler (all regular queries)
// DATABASE_DIRECT_URL → direct (LISTEN only)
```

2. **Keep transactions short** — don't await external calls (webhook, payment API) inside a database transaction:
```typescript
// WRONG
await db.transaction(async (tx) => {
  const order = await tx.insert(orders).values(...).returning();
  await mercadopago.payment.create(...); // External call INSIDE transaction — holds connection
  await tx.insert(notifications)...;
});

// CORRECT
const paymentResult = await mercadopago.payment.create(...); // External call OUTSIDE transaction
await db.transaction(async (tx) => {
  await tx.insert(orders).values({ ...orderData, paymentId: paymentResult.id });
  await tx.insert(notifications)...;
});
```

3. **Monitor `pg_stat_activity`** — if connections are accumulated, identify which queries hold them longest.

**Phase:** Flash-Consumer (order creation) — this is the highest-frequency write path. Connection patterns set here affect all subsequent modules.

---

### Pitfall 9: MercadoPago Webhook — Pedidos Duplicados por Retries

**What goes wrong:**
MercadoPago retries webhook delivery if your endpoint returns a non-2xx response, or if it doesn't respond within their timeout window. If your webhook handler is slow (e.g., complex order creation logic, Neon cold start wake-up during the handler), MercadoPago delivers the webhook 2–3 times. Without idempotency checks, you create 2–3 duplicate orders for one payment.

This is closely related to Pitfall 3, but specifically about webhook retry behavior rather than client-side double clicks.

**Prevention:**

Use the `payment_intents` table with a `UNIQUE` constraint on `external_payment_id` and a `status` state machine. The webhook handler's first action is an atomic status update:

```sql
BEGIN;
  UPDATE payment_intents
    SET status = 'processing'
    WHERE external_id = $webhook_payment_id AND status = 'pending'
    RETURNING id;
  -- If 0 rows returned → already processing or processed → return 200 immediately
COMMIT;
```

Return HTTP 200 to MercadoPago immediately once you've acknowledged receipt, even if the order creation takes another 500ms. Use a background job or the same transaction to complete order creation.

**Phase:** Flash-Consumer — payments phase.

---

### Pitfall 10: Elysia Type Inference Breaks con Zod o Validación Manual

**What goes wrong:**
A developer adds a Zod validator on a route instead of Elysia's native `t` (TypeBox-based) validator. The route works at runtime, but Elysia's compile-time type inference for `body`, `params`, `query` breaks — the inferred types become `unknown` instead of the typed schema. This means downstream code loses autocomplete and type safety. The bug is invisible until you realize the `eden` client or type checks no longer work correctly.

**Prevention:**
Always use Elysia's `t` (TypeBox) for schema validation. Never mix Zod validators with Elysia's type system on the same route:

```typescript
// WRONG
import { z } from 'zod';
.post('/orders', async ({ body }) => {
  const validated = z.object({ items: z.array(...) }).parse(body); // breaks type inference
})

// CORRECT
import { t } from 'elysia';
.post('/orders', async ({ body }) => {
  // body is already typed as the schema — use directly
  const { items } = body;
}, {
  body: t.Object({
    items: t.Array(t.Object({ menuItemId: t.Number(), quantity: t.Number() }))
  })
})
```

**Phase:** Foundation — establish the validation pattern in project conventions before any routes are written.

---

## Minor Pitfalls

---

### Pitfall 11: PostgreSQL RLS — Políticas Habilitadas pero Tabla No Alterada

**What goes wrong:**
`CREATE POLICY` statements are written but `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is never executed. The policies are silently ignored. All data remains visible to all roles.

**Prevention:**
If using RLS, always pair `CREATE POLICY` with `ENABLE ROW LEVEL SECURITY` in the same migration. Add an integration test that verifies a row is NOT visible to a user who shouldn't see it.

**Phase:** If RLS is used at all — auth/permissions phase.

---

### Pitfall 12: Stock Decrementado en Pedidos Cancelados / Fallidos

**What goes wrong:**
Stock is decremented when an order is created (before payment confirmation). If payment fails, the stock remains decremented but the order doesn't proceed. Over time, available quantities in Flash-Control don't match physical inventory.

**Prevention:**
Deduct stock only when payment is confirmed — either in the webhook handler (preferred) or using a reservation pattern:

```
Estado de stock: reserved (payment pending) → deducted (payment confirmed)
                                             → released (payment failed/cancelled)
```

Use separate `stock_reservations` records rather than mutating `quantity` directly until payment is final. This makes the reservation visible and reversible.

**Phase:** Flash-Consumer — payments + stock integration.

---

### Pitfall 13: Bun WebSocket Pub/Sub — `publishToSelf: false` es el Default

**What goes wrong:**
A delivery courier sends a GPS update via WebSocket. The backend calls `server.publish('delivery-events', data)`. The courier's own WebSocket connection does NOT receive the publish (because `publishToSelf` defaults to `false` in Bun). If the architect expects the publisher to also receive their own message (for confirmation), this is unexpected behavior.

More impactful: if the admin dashboard is subscribed to `delivery-events` and the courier is also subscribed, the courier won't see the admin's re-broadcasts — but this is usually the correct behavior. The issue is when the designer assumes otherwise.

**Prevention:**
Know the default: `publishToSelf: false`. If a sender needs to receive their own publish, use `server.publish()` (on the server instance, not `ws.publish()`) — the server-level publish reaches ALL subscribers including the sender.

**Phase:** Flash-Logistics WebSocket implementation.

---

### Pitfall 14: Neon Prepared Statements en Transaction Mode Pooler

**What goes wrong:**
Some libraries (older versions of `pg`, certain Drizzle configurations) cache prepared statements on the connection. When using Neon's transaction-mode pooler (PgBouncer), the physical connection changes between requests. Prepared statements cached on connection A are not available on connection B. The query fails with `prepared statement "s1" does not exist`.

**Prevention:**
The `@neondatabase/serverless` driver is designed for Neon's serverless environment and does not use connection-level prepared statement caching by default. Use it as recommended in STACK.md. If using raw SQL, use parameterized queries (`$1`, `$2`) not named prepared statements (`PREPARE stmt AS ...`).

**Phase:** Foundation — driver configuration. Already mitigated by the recommended stack (Neon serverless driver + Drizzle).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Schema + DB setup | LISTEN on pooled URL | Use `DATABASE_DIRECT_URL` for listener, `DATABASE_URL` (pooler) for queries |
| Order creation (Flash-Consumer) | Stock race condition | `SELECT FOR UPDATE` in transaction, consistent lock order |
| Order creation (Flash-Consumer) | Payment-order inconsistency | Webhook-first creation, `payment_intents` idempotency state machine |
| Order creation (Flash-Consumer) | Connection pool exhaustion | No external calls inside DB transactions |
| KDS real-time (Flash-KDS) | Silent LISTEN loss on reconnect | Supervised reconnection with backoff + keepalive |
| KDS real-time (Flash-KDS) | Orders lost on WS drop | Full state sync on connect/reconnect |
| GPS tracking (Flash-Logistics) | Table bloat from frequent updates | Write every 30s not every 5s; configure autovacuum; avoid indexing coordinate columns |
| Auth/roles | IDOR — courier sees others' orders | Ownership check on every query, not just role check |
| Payments | Duplicate orders from MP webhook retries | Atomic status update in `payment_intents` before order creation |
| Stock management (Flash-Control) | Negative stock | `SELECT FOR UPDATE`, only deduct on payment confirmation |
| Neon production | Scale-to-zero drops LISTEN | Auto-reconnect logic + consider disabling scale-to-zero |

---

## Sources

- PostgreSQL explicit locking docs — `SELECT FOR UPDATE`, deadlock prevention (official, live verified): https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL transaction isolation docs — READ COMMITTED limitations, lost updates (official, live verified): https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL LISTEN docs — session-scoped state, pool incompatibility (official, live verified): https://www.postgresql.org/docs/current/sql-listen.html
- PostgreSQL NOTIFY docs — queue behavior, transaction coupling (official, live verified): https://www.postgresql.org/docs/current/sql-notify.html
- PostgreSQL Row Level Security docs — BYPASSRLS, policy pitfalls (official, live verified): https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL autovacuum + MVCC docs — dead tuple accumulation (official, live verified): https://www.postgresql.org/docs/current/routine-vacuuming.html
- Bun WebSocket server docs — idleTimeout, pub/sub, publishToSelf (official, live verified): https://bun.sh/docs/api/websockets
- Neon connection pooler behavior — PgBouncer transaction mode, LISTEN incompatibility (training data, MEDIUM confidence; architectural behavior confirmed via PostgreSQL LISTEN docs)
- MercadoPago webhook retry behavior — idempotency requirements (training data, MEDIUM confidence; idempotency pattern is industry standard regardless of processor)
