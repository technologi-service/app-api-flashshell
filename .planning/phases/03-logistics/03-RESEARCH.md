# Phase 3: Logistics - Research

**Researched:** 2026-03-18
**Domain:** Elysia plugin, Drizzle ORM migration, PostgreSQL SELECT FOR UPDATE, pg_notify broadcast, GPS upsert throttle
**Confidence:** HIGH

## Summary

Phase 3 builds on a complete, stable Phase 2 codebase. Every pattern needed — Elysia plugin structure, auth macro + requireRole, pg_notify fan-out, SELECT FOR UPDATE transactions with direct pg.Pool, TypeBox validation — is already proven in production code. The research task is primarily mapping those established patterns to new routes, not discovering new techniques.

The logistics domain introduces two new concerns not present in prior phases: (1) a server-side 30-second throttle on GPS writes that must be checked before the upsert, and (2) a cross-plugin schema extension — `POST /consumer/orders` in the consumer plugin must accept a new `delivery_address` field. Both are additive changes that fit cleanly into existing patterns.

The `orders` table needs a Phase 3 migration to add `courier_id` (uuid, nullable, FK to `user.id`) and `delivery_address` (text, not null). The `courier_locations` table already exists with the correct shape. No new dependencies are required.

**Primary recommendation:** Build two service files (`logistics/service.ts` and `couriers/service.ts`) each using the established `pg.Pool` + `db.execute(sql\`pg_notify\`)` pattern. The logistics plugin handles pickup list + state machine; the couriers plugin handles GPS ingestion. Register both as separate Elysia instances under `/logistics` and `/couriers` prefixes, both using `requireRole('delivery')`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Courier Assignment Model**
- `orders` table gets two new columns via a Phase 3 migration: `courier_id` (uuid, nullable, FK to users) and `delivery_address` (text, not null)
- `POST /consumer/orders` (Phase 2 endpoint) must accept a `delivery_address` field in the request body — this is a Phase 3 extension to the Phase 2 endpoint
- Assignment is first-come-first-served: PATCH to `picked_up` atomically writes `courier_id = req.userId` and advances the order status. Concurrent attempts get `409 CONFLICT` (order already claimed)
- One active order per courier: server rejects PATCH to `picked_up` if the courier already has an order in `picked_up` status
- Courier can see orders from `preparing` status so they can anticipate and plan — but can only formally claim (transition to `picked_up`) once the order is in `ready_for_pickup`

**Pickup List (GET /logistics/orders/ready)**
- Returns orders in status `preparing` OR `ready_for_pickup` where `courier_id IS NULL` (unclaimed)
- Response per order: `id`, `status`, `items` (name + quantity per item), `totalAmount`, `delivery_address`, `createdAt`
- Includes customer delivery address so the courier knows the destination before pickup

**Order Detail (GET /logistics/orders/:id)**
- Logistics-specific endpoint, accessible only to `delivery` role
- Returns full order detail for courier view: `id`, `status`, `items`, `totalAmount`, `delivery_address`, `courier_id`, `createdAt`
- Only the assigned courier (or any delivery-role user for `preparing`/`ready_for_pickup` orders) can access

**Delivery State Machine**
- Single endpoint: `PATCH /logistics/orders/:id/status` with body `{ status: 'picked_up' | 'delivered' }`
- Valid transitions: `ready_for_pickup → picked_up`, `picked_up → delivered`
- Server enforces: only the assigned courier (`orders.courier_id === req.userId`) can advance the order once claimed
- No cancellation from courier side — if an issue occurs, admin handles it manually
- On `delivered`: order status set to `delivered`, GPS tracking stops automatically (no active order = no broadcast routing)

**WS Notifications on State Transitions**
- `picked_up` transition: `{ event: 'order_picked_up', orderId, courierId }` sent to both `order:{orderId}` and `control`
- `delivered` transition: `{ event: 'order_delivered', orderId }` sent to both `order:{orderId}` and `control`
- Both transitions use `pg_notify('flashshell_events', payload)` with `payload.channel` routing (same pattern as Phase 2)

**GPS Ingestion (POST /couriers/location)**
- Body: `{ lat: number, lng: number }`
- Authorization: must be `delivery` role AND have an active order in `picked_up` status — returns 403 otherwise
- Throttle: server-side silently ignore — if `courier_locations.updated_at` is less than 30 seconds ago, skip the upsert and return `200 OK` without writing
- When not throttled: upsert into `courier_locations` by `courier_id` (PK). 1 row per courier, always the current position
- After upsert: immediately broadcast via `pg_notify` to the customer's order channel

**GPS Broadcast Payload**
- Channel: `order:{orderId}` (customer is already subscribed from order creation — no new subscription needed)
- Event shape: `{ event: 'courier_location', orderId, lat, lng, timestamp }`
- `orderId` is resolved server-side: look up the courier's active `picked_up` order to find the target channel
- Broadcast stops automatically when order reaches `delivered` — routing query returns null

### Claude's Discretion
- Exact Drizzle column types for `delivery_address` (text vs varchar length)
- Index strategy for the `courier_id IS NULL` filter on the pickup list query
- Exact `pg_notify` channel routing implementation for GPS broadcast
- TypeBox schema organization within the logistics plugin
- Whether to use a single `logisticsPlugin` or split into `logisticsPlugin` + `courierPlugin` by prefix

### Deferred Ideas (OUT OF SCOPE)
- Multi-order batching with geo-proximity
- GPS route history for delivery optimization
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LOGI-01 | Repartidor autenticado puede ver la lista de pedidos con estado `ready` disponibles para retirar | `GET /logistics/orders/ready` — Drizzle query with `inArray(['preparing', 'ready_for_pickup'])` + `isNull(orders.courierId)` filter; requires Phase 3 migration adding `courier_id` column |
| LOGI-02 | App del repartidor puede enviar coordenadas GPS al backend (POST /couriers/location, upsert en `courier_location`, máximo cada 30s) | `POST /couriers/location` — server-side throttle check against `courier_locations.updated_at`; upsert via Drizzle `.insert().onConflictDoUpdate()` on PK `courier_id`; `courier_locations` table already exists |
| LOGI-03 | Las coordenadas GPS del repartidor se retransmiten en tiempo real por WebSocket al cliente | `pg_notify('flashshell_events', { channel: 'order:{orderId}', event: 'courier_location', ... })` after upsert; same listener.ts fan-out pattern used in Phase 2; customer already subscribed to `order:{orderId}` |
| LOGI-04 | Repartidor puede actualizar el estado de entrega: `picked_up` → `delivered`; cada cambio notifica al cliente y al admin | `PATCH /logistics/orders/:id/status` — SELECT FOR UPDATE on `orders` via direct pg.Pool; dual `pg_notify` on `order:{orderId}` and `control` channels; same concurrency pattern as Phase 2 stock locking |
</phase_requirements>

---

## Standard Stack

### Core (all already in package.json — no new installs)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| elysia | latest (1.4.x) | HTTP routing, plugin registration | Locked stack |
| drizzle-orm | 0.45.1 | Schema definition, query builder, migration generation | Locked stack |
| pg | 8.20.0 | Direct pg.Pool for SELECT FOR UPDATE transactions | Established in Phase 2 (consumer/service.ts) |
| @neondatabase/serverless | 1.0.2 | Neon HTTP client for non-transactional queries | Established in Phase 1 |

### No New Dependencies Required
All required libraries are already installed. Phase 3 is pure plugin + service code.

**Version verification:** `bun pm ls` in project root confirms installed versions match above.

---

## Architecture Patterns

### Recommended Project Structure (Phase 3 additions)

```
src/
├── plugins/
│   ├── logistics/
│   │   ├── index.ts       # logisticsPlugin — /logistics routes
│   │   ├── service.ts     # getPickupList, getOrderDetail, advanceOrderStatus
│   │   └── model.ts       # TypeBox schemas: AdvanceStatusBody, etc.
│   ├── couriers/
│   │   ├── index.ts       # couriersPlugin — /couriers routes
│   │   ├── service.ts     # updateCourierLocation (throttle + upsert + notify)
│   │   └── model.ts       # TypeBox: UpdateLocationBody
│   └── consumer/
│       ├── index.ts       # PATCH: add delivery_address to POST /orders (Phase 3 extension)
│       └── model.ts       # PATCH: add delivery_address field to CreateOrderBody
├── db/
│   ├── schema/
│   │   └── orders.ts      # PATCH: add courierId + deliveryAddress columns
│   └── migrations/
│       └── 0003_add_courier_columns.sql  # new Phase 3 migration
```

**Discretion recommendation:** Split into `logisticsPlugin` (/logistics) and `couriersPlugin` (/couriers). The two prefixes serve different concerns (order state vs GPS) and separate `requireRole` + service dependencies make the split clean. Consistent with kdsPlugin pattern where a single pillar = one plugin file.

### Pattern 1: Elysia Plugin with requireRole('delivery')

Established pattern from kdsPlugin. Apply identically:

```typescript
// src/plugins/logistics/index.ts
import { Elysia } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'

export const logisticsPlugin = new Elysia({ name: 'logistics', prefix: '/logistics' })
  .use(authPlugin)
  .use(requireRole('delivery'))
  .get('/orders/ready', ({ user }) => getPickupList(), { auth: true })
  .get('/orders/:id', ({ params, user, status }) => getOrderDetail(params.id, user.id), { auth: true })
  .patch(
    '/orders/:id/status',
    async ({ params, body, user, status }) => { /* ... */ },
    { auth: true, body: AdvanceStatusBody }
  )
```

Source: existing `src/plugins/kds/index.ts` — direct copy pattern.

### Pattern 2: SELECT FOR UPDATE via direct pg.Pool (Courier Assignment)

The courier `picked_up` claim is a race-condition-sensitive operation identical to stock locking in Phase 2. Must use `DATABASE_DIRECT_URL` + pg.Pool — NOT the Neon HTTP client.

```typescript
// src/plugins/logistics/service.ts
import { Pool } from 'pg'

const txPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  max: 5
})

export async function advanceOrderStatus(
  orderId: string,
  courierId: string,
  newStatus: 'picked_up' | 'delivered'
): Promise<{ ok: boolean; error?: string }> {
  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT id, status, courier_id FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    )
    const order = rows[0]
    if (!order) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'NOT_FOUND' }
    }

    // Validate transition
    if (newStatus === 'picked_up') {
      if (order.status !== 'ready_for_pickup') {
        await client.query('ROLLBACK')
        return { ok: false, error: 'INVALID_TRANSITION' }
      }
      if (order.courier_id !== null) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'ALREADY_CLAIMED' }
      }
      // Check one-active-order constraint
      const { rows: activeOrders } = await client.query(
        `SELECT id FROM orders WHERE courier_id = $1 AND status = 'picked_up'`,
        [courierId]
      )
      if (activeOrders.length > 0) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'COURIER_BUSY' }
      }

      await client.query(
        `UPDATE orders SET status = 'picked_up', courier_id = $1, updated_at = NOW() WHERE id = $2`,
        [courierId, orderId]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: `order:${orderId}`, event: 'order_picked_up', orderId, courierId })]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: 'control', event: 'order_picked_up', orderId, courierId })]
      )
    } else {
      // delivered
      if (order.status !== 'picked_up' || order.courier_id !== courierId) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'FORBIDDEN' }
      }
      await client.query(
        `UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
        [orderId]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: `order:${orderId}`, event: 'order_delivered', orderId })]
      )
      await client.query(
        `SELECT pg_notify('flashshell_events', $1::text)`,
        [JSON.stringify({ channel: 'control', event: 'order_delivered', orderId })]
      )
    }

    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

Source: `src/plugins/consumer/service.ts` — direct structural copy.

### Pattern 3: GPS Upsert with Server-Side Throttle

The throttle check is a plain SELECT before the upsert. No external cache needed — reads `updated_at` from the existing `courier_locations` row.

```typescript
export async function updateCourierLocation(
  courierId: string,
  lat: number,
  lng: number
): Promise<{ throttled: boolean; orderId: string | null }> {
  // Check throttle: skip if updated within last 30 seconds
  const existing = await db
    .select({ updatedAt: courierLocations.updatedAt })
    .from(courierLocations)
    .where(eq(courierLocations.courierId, courierId))
    .limit(1)

  if (existing.length > 0) {
    const age = Date.now() - existing[0].updatedAt.getTime()
    if (age < 30_000) return { throttled: true, orderId: null }
  }

  // Find active order for broadcast routing
  const activeOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      sql`${orders.courierId} = ${courierId}::uuid AND ${orders.status} = 'picked_up'`
    )
    .limit(1)

  const orderId = activeOrder[0]?.id ?? null

  // Upsert location
  await db
    .insert(courierLocations)
    .values({ courierId, lat: String(lat), lng: String(lng), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: courierLocations.courierId,
      set: { lat: String(lat), lng: String(lng), updatedAt: new Date() }
    })

  // Broadcast if courier has active order
  if (orderId) {
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
  }

  return { throttled: false, orderId }
}
```

**Note on GPS active-order check:** The authorization check (does courier have a `picked_up` order?) happens in the route handler before calling the service. The service also does a lookup for the broadcast channel. These two queries can be combined into one if desired — route handler resolves `orderId` and passes it to service, eliminating duplicate DB round-trip.

Source: `src/plugins/kds/service.ts` pg_notify pattern; `src/db/schema/logistics.ts` for courierLocations shape.

### Pattern 4: Drizzle onConflictDoUpdate (Upsert)

`courierLocations` uses `courierId` as PK. Drizzle's `.onConflictDoUpdate()` is the correct upsert method:

```typescript
await db.insert(courierLocations)
  .values({ courierId, lat, lng, updatedAt: new Date() })
  .onConflictDoUpdate({
    target: courierLocations.courierId,
    set: { lat, lng, updatedAt: new Date() }
  })
```

Source: Drizzle ORM documentation, `INSERT ... ON CONFLICT DO UPDATE` pattern. Confidence: HIGH — this API is stable and the table PK design was specifically chosen for this pattern (Phase 1 decision log).

### Pattern 5: Phase 3 Migration — Adding Columns to `orders`

Must NOT amend existing migrations. Create new file `0003_add_courier_columns.sql`:

```sql
ALTER TABLE "orders"
  ADD COLUMN "courier_id" text,
  ADD COLUMN "delivery_address" text NOT NULL DEFAULT '';

-- Remove default after backfill (or leave if orders table is empty in dev)
ALTER TABLE "orders" ALTER COLUMN "delivery_address" DROP DEFAULT;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_courier_id_user_fk"
  FOREIGN KEY ("courier_id") REFERENCES "user"("id") ON DELETE SET NULL;
```

**Critical detail:** `user.id` in this schema is `text` (not uuid) — see migration `0001_wet_purple_man.sql` line 30: `"id" text PRIMARY KEY NOT NULL`. Therefore `courier_id` in `orders` must be declared as `text` (not `uuid`) to match the FK target. The `courierLocations.courierId` column is `uuid` — this is OK because it references courier identity internally, not the `user.id` PK directly.

**Drizzle schema update for `orders.ts`:**

```typescript
// Add to orders table definition:
courierId: text('courier_id'),           // nullable, FK to user.id (text PK)
deliveryAddress: text('delivery_address').notNull(),
```

**Discretion recommendation for delivery_address column type:** Use `text` (unbounded). Delivery addresses are free-form strings with variable length. `varchar(255)` risks truncation for verbose addresses. `text` matches existing pattern in this codebase (all string columns use text).

### Pattern 6: Index Strategy for Pickup List

The `GET /logistics/orders/ready` query filters `status IN ('preparing', 'ready_for_pickup') AND courier_id IS NULL`. For v1 single-tenant with modest order volume, a composite index provides acceptable performance:

```sql
CREATE INDEX idx_orders_pickup_list
  ON orders (status, courier_id)
  WHERE status IN ('preparing', 'ready_for_pickup') AND courier_id IS NULL;
```

This partial index targets exactly the pickup list filter. Include in the Phase 3 migration SQL. Confidence: MEDIUM — adequate for v1 volumes; PostGIS or GiST index not needed until Phase V2 geo features.

### Pattern 7: Consumer Plugin Extension (delivery_address)

`POST /consumer/orders` must accept `delivery_address`. Minimal change to `consumer/model.ts`:

```typescript
export const CreateOrderBody = t.Object({
  items: t.Array(
    t.Object({
      menuItemId: t.String({ format: 'uuid' }),
      quantity: t.Integer({ minimum: 1 })
    }),
    { minItems: 1 }
  ),
  deliveryAddress: t.String({ minLength: 1 })  // Phase 3 addition
})
```

And pass it through in `consumer/service.ts` `createOrder()` — add `deliveryAddress` to the INSERT statement.

### Anti-Patterns to Avoid

- **Using `db` (Neon HTTP) for SELECT FOR UPDATE:** Neon HTTP client does not support transactions. Use `txPool` (direct pg.Pool on DATABASE_DIRECT_URL) for any BEGIN/COMMIT block. Already established in Phase 2.
- **pg_notify outside transaction for assignment:** The courier assignment UPDATE and the `pg_notify` for `order_picked_up` must be in the same transaction so the notification is only sent when the commit succeeds.
- **Using `courier_locations.courierId` typed as `uuid` in Drizzle for a FK to `user.id` typed as `text`:** Do not add a Drizzle-level FK reference from `courierLocations.courierId` to `user.id` — the type mismatch would cause Drizzle migration generation errors. The FK is enforced at SQL level in the migration, or omitted for `courier_locations` (already no FK in existing schema).
- **Checking `orders.courier_id` type mismatch:** `user.id` is `text`, so `courier_id` in orders must be `text`. Do not declare it as `uuid` in Drizzle schema.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| GPS upsert | Custom MERGE logic | Drizzle `.onConflictDoUpdate()` | PK-based upsert is a single SQL statement; already designed for this in Phase 1 |
| Request throttle | Redis rate limiter | `courier_locations.updated_at` check | No Redis in v1; DB timestamp is sufficient for 30-second granularity |
| WS broadcast routing | New channel registry | Existing `listener.ts` `dispatch(channel, payload)` | Fan-out is already implemented and tested |
| Race condition prevention | Application-level optimistic locking | `SELECT FOR UPDATE` + pg.Pool on direct URL | Proven in Phase 2 — exact same pattern needed |
| Auth validation | Custom JWT parsing | `authPlugin` macro + `requireRole('delivery')` | Established in Phase 1, reused in every plugin since |

---

## Common Pitfalls

### Pitfall 1: courier_id Column Type Mismatch (text vs uuid)

**What goes wrong:** Declaring `courier_id` as `uuid` in Drizzle schema while `user.id` is `text` causes FK constraint failure in PostgreSQL or Drizzle migration generation error.
**Why it happens:** The `user` table (Better Auth managed) uses `text` PK, not `uuid`. This is visible in `0001_wet_purple_man.sql` line 30.
**How to avoid:** Declare `courierId: text('courier_id')` in `orders.ts`. The FK reference in SQL is to `"user"("id")` which is text. Do NOT use `uuid()` Drizzle column type for this FK.
**Warning signs:** Migration generates `ERROR: foreign key constraint ... incompatible types`.

### Pitfall 2: PgBouncer Kills SELECT FOR UPDATE (Already Documented)

**What goes wrong:** Using `DATABASE_URL` (pooled) for the assignment transaction — PgBouncer transaction mode may route different queries to different backend connections, breaking row lock guarantees.
**Why it happens:** PgBouncer transaction mode does not preserve connection across statements in a transaction.
**How to avoid:** Use `DATABASE_DIRECT_URL` for all `pg.Pool` instances that run transactions with `SELECT FOR UPDATE`. Already established in Phase 2-03 (STATE.md decision log).
**Warning signs:** Concurrent assignment requests both succeed (no 409 returned).

### Pitfall 3: GPS Authorization — Two Separate Checks

**What goes wrong:** Only checking `delivery` role, not checking for active `picked_up` order — allowing any delivery user to push GPS coordinates even without an active delivery.
**Why it happens:** `requireRole('delivery')` only enforces role, not business state.
**How to avoid:** In the route handler (before calling service), query for the courier's active `picked_up` order. Return 403 if none found. This query also doubles as the broadcast channel resolver.

### Pitfall 4: delivery_address NOT NULL Without Default in Migration

**What goes wrong:** Adding `delivery_address text NOT NULL` to a table that may have existing rows causes the migration to fail with "column cannot contain null values".
**Why it happens:** Existing orders (from Phase 2 integration tests or dev data) don't have `delivery_address`.
**How to avoid:** Add with `DEFAULT ''` then drop the default, OR ensure dev/test DB is reset before Phase 3 migration. Both approaches are safe — document the choice.

### Pitfall 5: Throttle Check Race (Acceptable for v1)

**What goes wrong:** Two concurrent GPS requests both read `updated_at` before either writes, both pass the 30-second check, and both upsert.
**Why it happens:** The throttle check and upsert are not in a transaction.
**How to avoid:** For v1, this is acceptable — LOGI-02 says "at most every 30 seconds to prevent DB bloat", not "exactly every 30 seconds". The requirement is met even if rare concurrent writes slip through. A transaction lock would be over-engineered.
**Warning signs:** Only a problem if GPS requests are genuinely concurrent at sub-millisecond granularity (unlikely in practice).

### Pitfall 6: Consumer Service Must Pass delivery_address to INSERT

**What goes wrong:** Adding `delivery_address` to the TypeBox schema but forgetting to include it in the raw SQL INSERT in `consumer/service.ts`.
**Why it happens:** `consumer/service.ts` uses raw `pg.Client` queries (not Drizzle), so schema changes don't auto-propagate.
**How to avoid:** Search for the `INSERT INTO orders` statement in `service.ts` and add `delivery_address` column + `$N` parameter explicitly.

---

## Code Examples

Verified patterns from existing codebase:

### pg_notify Fan-Out (from kds/service.ts)
```typescript
// Source: src/plugins/kds/service.ts lines 47-54
await db.execute(
  sql`SELECT pg_notify('flashshell_events', ${JSON.stringify({
    channel: `order:${orderId}`,
    event: 'item_status_changed',
    orderId,
    itemId,
    status: newStatus
  })}::text)`
)
```
Use this pattern for all pg_notify calls that don't need to be inside a pg.Pool transaction.

### pg_notify Inside Transaction (from consumer/service.ts)
```typescript
// Source: src/plugins/consumer/service.ts lines 187-200
await client.query(
  `SELECT pg_notify('flashshell_events', $1::text)`,
  [JSON.stringify({
    channel: 'kds',
    event: 'new_order',
    orderId,
    /* ... */
  })]
)
await client.query('COMMIT')
```
Use `client.query(pg_notify...)` before COMMIT when broadcast must be atomic with the state change.

### TypeBox Schema with Enum (for AdvanceStatusBody)
```typescript
// Source: src/plugins/kds/model.ts pattern
import { t } from 'elysia'

export const AdvanceStatusBody = t.Object({
  status: t.Union([t.Literal('picked_up'), t.Literal('delivered')])
})
export type AdvanceStatusBody = typeof AdvanceStatusBody.static
```

### requireRole applied to logistics
```typescript
// Source: src/plugins/kds/index.ts — identical pattern
import { requireRole } from '../auth/require-role'
export const logisticsPlugin = new Elysia({ name: 'logistics', prefix: '/logistics' })
  .use(authPlugin)
  .use(requireRole('delivery'))
  // routes...
```

### Drizzle inArray + isNull filter (for pickup list)
```typescript
import { inArray, isNull } from 'drizzle-orm'

const pickupList = await db
  .select({ id: orders.id, status: orders.status, /* ... */ })
  .from(orders)
  .where(
    sql`${orders.status} IN ('preparing', 'ready_for_pickup') AND ${orders.courierId} IS NULL`
  )
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `FOR UPDATE OF` on joined table | Two-step lock: separate `SELECT FOR UPDATE` on target table | Phase 02-03 | PostgreSQL rejects FOR UPDATE on nullable side of outer join |
| `DATABASE_URL` for transactions | `DATABASE_DIRECT_URL` for pg.Pool transactions | Phase 02-03 | PgBouncer transaction mode breaks SELECT FOR UPDATE |
| Single plugin file | `index.ts` + `service.ts` + `model.ts` per plugin | Established Phase 1 | Separation of routing, business logic, schema |

---

## Open Questions

1. **Active-order check for GPS authorization — combined query or two queries?**
   - What we know: Route handler needs orderId for broadcast routing AND needs to validate courier has active order
   - What's unclear: Whether to combine into one query in handler, or pass orderId from handler to service
   - Recommendation: Resolve in one query in the handler: `SELECT id FROM orders WHERE courier_id = $1 AND status = 'picked_up' LIMIT 1`. If null → 403. If found → pass orderId to service, skipping the duplicate lookup in service.

2. **Migration `delivery_address` NOT NULL + existing rows**
   - What we know: Phase 2 integration tests may have created orders in the DB without `delivery_address`
   - What's unclear: Whether the test/dev Neon DB has rows in the `orders` table
   - Recommendation: Use `DEFAULT ''` in migration, then `ALTER COLUMN DROP DEFAULT`. This is always safe regardless of existing data.

3. **Plugin split: single `logisticsPlugin` or `logisticsPlugin` + `couriersPlugin`?**
   - What we know: CONTEXT.md marks this as Claude's discretion
   - Recommendation: Two plugins. `/logistics` handles order state (delivery role reads/writes orders). `/couriers` handles GPS ingestion (delivery role pushes location). Different prefixes, same role. This matches the two plan files: `03-01` (logistics) and `03-02` (GPS broadcast).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Bun test (built-in) |
| Config file | none — `bun test` discovers `test/**/*.test.ts` automatically |
| Quick run command | `bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LOGI-01 | GET /logistics/orders/ready returns preparing + ready_for_pickup unclaimed orders | unit (mocked service) | `bun test test/plugins/logistics.test.ts` | ❌ Wave 0 |
| LOGI-01 | Returns 403 for non-delivery role | unit (mocked auth) | `bun test test/plugins/logistics.test.ts` | ❌ Wave 0 |
| LOGI-02 | POST /couriers/location upserts when >30s since last update | unit (mocked db) | `bun test test/plugins/couriers.test.ts` | ❌ Wave 0 |
| LOGI-02 | POST /couriers/location returns 200 without writing when <30s since last update | unit (mocked db) | `bun test test/plugins/couriers.test.ts` | ❌ Wave 0 |
| LOGI-03 | pg_notify called with correct courier_location payload after upsert | unit (spy on db.execute) | `bun test test/plugins/couriers.test.ts` | ❌ Wave 0 |
| LOGI-04 | PATCH status to picked_up sets courier_id, returns 409 on conflict | unit (mocked service) | `bun test test/plugins/logistics.test.ts` | ❌ Wave 0 |
| LOGI-04 | PATCH status to delivered sends pg_notify to both order:{id} and control | unit (spy on pg_notify) | `bun test test/plugins/logistics.test.ts` | ❌ Wave 0 |
| LOGI-04 | Concurrent picked_up claims — only one succeeds (409 for second) | integration (live DB) | `bun test test/integration/logistics-concurrency.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/plugins/logistics.test.ts` — covers LOGI-01, LOGI-04 (unit, mocked service + auth)
- [ ] `test/plugins/couriers.test.ts` — covers LOGI-02, LOGI-03 (unit, mocked db)
- [ ] `test/integration/logistics-concurrency.test.ts` — covers LOGI-04 concurrent assignment race (live DB, mirrors `order-concurrency.test.ts` pattern)

*(No new framework install needed — bun:test is already in use)*

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/plugins/kds/service.ts` — pg_notify pattern, auto-advance with SELECT FOR UPDATE
- Direct code inspection: `src/plugins/consumer/service.ts` — pg.Pool + DATABASE_DIRECT_URL + pg_notify inside transaction
- Direct code inspection: `src/plugins/ws/listener.ts` — dispatch(channel, payload) fan-out
- Direct code inspection: `src/db/schema/logistics.ts` — courierLocations table shape (PK on courierId)
- Direct code inspection: `src/db/schema/orders.ts` — orderStatusEnum values confirmed
- Direct code inspection: `src/db/migrations/0001_wet_purple_man.sql` — user.id is `text` PK (not uuid)
- `.planning/phases/03-logistics/03-CONTEXT.md` — all locked decisions, patterns, integration points

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` accumulated decisions — PgBouncer + SELECT FOR UPDATE pattern, pg_notify atomicity requirement
- `.agents/skills/elysiajs/SKILL.md` — Elysia encapsulation, scoped macro, method chaining rules

### Tertiary (LOW confidence)
- None — all findings are directly verifiable from existing codebase

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already installed and in use
- Architecture: HIGH — all patterns are direct copies of existing, working code
- Pitfalls: HIGH — pitfalls 1-4 derived from existing STATE.md decisions and direct schema inspection; pitfall 5-6 from code reading
- Migration: HIGH for column types; MEDIUM for index effectiveness at scale (v1 acceptable)
- Test patterns: HIGH — mirrors existing test/plugins/kds.test.ts structure exactly

**Research date:** 2026-03-18
**Valid until:** 2026-06-18 (stable — no fast-moving dependencies; all findings are internal code patterns)
