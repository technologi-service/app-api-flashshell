# Phase 2: Core Order Pipeline - Research

**Researched:** 2026-03-16
**Domain:** Elysia plugin authoring, Drizzle SELECT FOR UPDATE, pg_notify fan-out, WebSocket channel routing
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Order State in Phase 2 (without payment)**
- `POST /consumer/orders` auto-advances the order from `pending` → `confirmed` atomically in the same transaction — no separate payment step in Phase 2
- The KDS plugin watches `confirmed` orders, not `pending`
- Phase 5 (Stripe) will remove this auto-confirm behavior: `POST /consumer/orders` will instead stay `pending` and return a Payment Intent; the Stripe webhook advances `pending → confirmed`
- The rest of the state machine (`confirmed → preparing → ready_for_pickup → ...`) is untouched by Phase 5 — no KDS code needs updating

**POST /consumer/orders Response**
- Returns the full order object on success: `id`, `status` (`confirmed`), `totalAmount`, and `items` array (name, quantity, unitPrice per item)
- Client has everything it needs to display a confirmation screen without a follow-up GET

**Stock Failure Policy**
- Reject the **whole order** with `409 CONFLICT` if ANY item fails validation
- Two conditions trigger rejection: item is `isAvailable = false` OR item stock quantity is 0
- Both conditions checked in the same `SELECT FOR UPDATE` query
- Error body identifies which items failed (so client UI can highlight them)
- No partial fulfillment — atomic accept-or-reject only

**KDS Push Payload (new order)**
- When an order is confirmed, `pg_notify('flashshell_events', payload)` fires to channel `kds`
- The push payload embeds the full order: `{ event: 'new_order', orderId, createdAt, items: [{ itemId, name, quantity }] }`
- Chef's KDS screen renders the new ticket immediately — no follow-up HTTP call needed

**Consumer WebSocket Events (item updates)**
- When chef marks an item status change via PATCH, the consumer's `order:{orderId}` channel receives:
  `{ event: 'item_status_changed', orderId, itemId, status: 'preparing' | 'ready' }`
- Granular item events only — consumer does NOT receive chef-internal order-level transitions
- Consumer does receive an order-level event when the order reaches `ready_for_pickup` (order transitions)

**Item-level Status Tracking**
- `order_items` needs a new `item_status` column — **not in Phase 1 schema**, requires a new Drizzle migration
- Item state machine: `pending → preparing → ready` (3 states, no additional)
- New migration (0002_add_item_status): do NOT amend the Phase 1 migration

**Order Auto-advance (all items ready)**
- When the last item in an order reaches `ready`, the order automatically advances to `ready_for_pickup`
- Handled application-side in the PATCH /kds/orders/:id/items/:itemId handler — no DB trigger
- The auto-advance fires `pg_notify` to both `kds` (order done) and `logistics` (ready for pickup) channels
- KDS-04 is covered implicitly by auto-advance — no separate PATCH /kds/orders/:id endpoint needed in Phase 2

### Claude's Discretion
- Exact `pg_notify` payload field names beyond what's specified above
- Drizzle column type for item_status (pgEnum vs text with check)
- Index strategy on order_items for the status query
- CONS-07 (order history) endpoint shape — return list with id, status, totalAmount, createdAt per order; pagination optional

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONS-01 | GET /consumer/menu — all active menu items with price, description, availability | menuItems table has isAvailable; simple SELECT with WHERE isAvailable=true |
| CONS-02 | POST /consumer/orders — create order with items, validate stock | SELECT FOR UPDATE on ingredients; insert orders + order_items in transaction |
| CONS-03 | SELECT FOR UPDATE prevents race conditions on concurrent stock reservations | Drizzle `for('update')` clause on neon-http client; requires transaction wrapper |
| CONS-06 | Consumer subscribes via WebSocket to order status; receives item_status_changed events | Existing wsPlugin + listener.ts dispatch(); channel `order:{orderId}` |
| CONS-07 | Authenticated customer views order history | SELECT orders WHERE customerId=user.id; return id, status, totalAmount, createdAt |
| KDS-01 | Chef receives WebSocket push <500ms when new order confirmed | pg_notify in same transaction as order confirm; listener.ts fans out to `kds` channel |
| KDS-02 | Chef PATCHes item to `preparing` | PATCH /kds/orders/:id/items/:itemId; UPDATE order_items SET item_status='preparing' |
| KDS-03 | Chef PATCHes item to `ready`; triggers auto-advance check | Same endpoint, different status; check all items ready → auto-advance order |
| KDS-04 | Order advances to ready_for_pickup (auto, no separate endpoint in Phase 2) | Application-side in PATCH handler; covered by KDS-03 auto-advance logic |
| KDS-05 | Chef toggles menu item availability; change reflects immediately for consumers | PATCH /kds/menu/:itemId/availability; UPDATE menu_items SET isAvailable; no cache to invalidate |
</phase_requirements>

---

## Summary

Phase 2 builds on the fully-verified Phase 1 foundation. All infrastructure (db client, auth middleware, WS hub, pg_notify listener) is in place and confirmed working. The work is three new Elysia plugins (`consumerPlugin`, `kdsPlugin`, and optionally a WS channel test) plus one Drizzle migration that adds `item_status` to `order_items`.

The most technically complex piece is the `POST /consumer/orders` handler: it must open a PostgreSQL transaction, acquire `SELECT FOR UPDATE` locks on the relevant `ingredients` rows, validate availability and stock, insert the order atomically, update order status to `confirmed`, and call `pg_notify` — all in a single transaction. The Neon HTTP client (`@neondatabase/serverless`) does not support `SELECT FOR UPDATE` because HTTP is stateless. The solution is to use the `pg` client (already installed as a dependency) with a pooled connection for transactional queries only.

The real-time 500ms SLA (KDS-01) is met by embedding the full order in the `pg_notify` payload so the KDS screen renders immediately without a follow-up REST call. The existing `listener.ts` LISTEN/NOTIFY hub fans the notification out to all sockets subscribed to the `kds` channel without any code changes.

**Primary recommendation:** Use `pg.Pool` (from the already-installed `pg` package) for transactional queries (`SELECT FOR UPDATE`, multi-step inserts). Continue using the Drizzle `db` client for all read-only and simple write queries outside transactions.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| elysia | latest (1.4.x) | HTTP routing, plugin system, TypeBox validation | Project mandate; all Phase 1 plugins use it |
| drizzle-orm | ^0.45.1 | ORM for read/write queries outside transactions | Already in use; project standard |
| @neondatabase/serverless | ^1.0.2 | Pooled HTTP Neon client; used by `db` singleton | Already wired in db/client.ts |
| pg | ^8.20.0 | PostgreSQL node driver; `pg.Pool` for transactions | Already installed; used by ws/listener.ts for pg.Client |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| elysia `t` (TypeBox) | bundled | Request body / response validation | Every new route body |
| drizzle-kit | ^0.31.9 | Generate migration SQL from schema diff | Adding item_status column |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `pg.Pool` for transactions | `neon()` transaction helper | Neon HTTP transactions use `neon(url, { transaction: true })` but this still does not support `SELECT FOR UPDATE` (row-level locking requires a persistent connection) |
| pgEnum for item_status | text column with check constraint | pgEnum is more type-safe and matches the project pattern (orderStatusEnum already uses pgEnum); recommended |

**Installation:** No new packages needed — `pg` is already installed.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── plugins/
│   ├── consumer/
│   │   ├── index.ts      # consumerPlugin — GET /consumer/menu, POST /consumer/orders, GET /consumer/orders
│   │   ├── service.ts    # createOrder() — transaction logic, SELECT FOR UPDATE, pg_notify
│   │   └── model.ts      # TypeBox schemas for request/response bodies
│   ├── kds/
│   │   ├── index.ts      # kdsPlugin — GET /kds/orders, PATCH /kds/orders/:id/items/:itemId, PATCH /kds/menu/:itemId/availability
│   │   ├── service.ts    # updateItemStatus(), toggleAvailability() — db logic, pg_notify
│   │   └── model.ts      # TypeBox schemas
│   ├── auth/             # Phase 1 — unchanged
│   ├── health/           # Phase 1 — unchanged
│   └── ws/               # Phase 1 — unchanged
└── db/
    ├── schema/
    │   └── orders.ts     # Add itemStatusEnum + item_status column to orderItems
    └── migrations/
        └── 0002_add_item_status.sql  # generated by drizzle-kit generate
```

### Pattern 1: Elysia Plugin with Auth + Role Guard

**What:** Each domain plugin declares its dependencies explicitly by calling `.use(authPlugin)` and `.use(requireRole(...))`.
**When to use:** Every protected route set (consumerPlugin needs `customer`, kdsPlugin needs `chef`).

```typescript
// Source: src/plugins/auth/index.ts + require-role.ts (Phase 1 verified)
import { Elysia } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'

export const consumerPlugin = new Elysia({ name: 'consumer', prefix: '/consumer' })
  .use(authPlugin)
  .use(requireRole('customer'))
  .get('/menu', () => { /* ... */ }, { auth: true })
  .post('/orders', ({ body, user }) => { /* ... */ }, { auth: true, body: OrderBody })
  .get('/orders', ({ user }) => { /* ... */ }, { auth: true })

export const kdsPlugin = new Elysia({ name: 'kds', prefix: '/kds' })
  .use(authPlugin)
  .use(requireRole('chef'))
  .get('/orders', () => { /* ... */ }, { auth: true })
  .patch('/orders/:id/items/:itemId', ({ params, body }) => { /* ... */ }, { auth: true })
  .patch('/menu/:itemId/availability', ({ params, body }) => { /* ... */ }, { auth: true })
```

### Pattern 2: Transaction with SELECT FOR UPDATE via pg.Pool

**What:** Use `pg.Pool` (persistent connection) for transactional operations. The Neon HTTP client cannot hold row-level locks.
**When to use:** `POST /consumer/orders` — the only endpoint in Phase 2 that requires `SELECT FOR UPDATE`.

```typescript
// Source: Drizzle + pg docs; pattern verified against pg v8 API
import { Pool } from 'pg'

// Separate pool for transactional queries — NOT the Drizzle db client
const txPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5  // small pool — transactions are short-lived
})

async function createOrderTx(customerId: string, items: OrderItem[]) {
  const client = await txPool.connect()
  try {
    await client.query('BEGIN')

    // 1. Lock ingredient rows — SELECT FOR UPDATE prevents concurrent stock depletion
    const menuItemIds = items.map(i => i.menuItemId)
    const { rows: menuRows } = await client.query(
      `SELECT mi.id, mi.name, mi.is_available, mi.price,
              i.id as ingredient_id, i.stock_quantity, mii.quantity_used
       FROM menu_items mi
       LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
       LEFT JOIN ingredients i ON i.id = mii.ingredient_id
       WHERE mi.id = ANY($1::uuid[])
       FOR UPDATE OF i`,
      [menuItemIds]
    )

    // 2. Validate — collect all failures before rejecting
    const failures: string[] = []
    for (const item of items) {
      const row = menuRows.find(r => r.id === item.menuItemId)
      if (!row || !row.is_available) failures.push(item.menuItemId)
      else if (Number(row.stock_quantity) < item.quantity * Number(row.quantity_used)) {
        failures.push(item.menuItemId)
      }
    }
    if (failures.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, failures }
    }

    // 3. Insert order + items, advance to confirmed in one transaction
    // ... INSERT INTO orders, INSERT INTO order_items, UPDATE orders SET status='confirmed'

    // 4. Notify KDS
    await client.query(
      `SELECT pg_notify('flashshell_events', $1)`,
      [JSON.stringify({ channel: 'kds', event: 'new_order', orderId, createdAt, items })]
    )

    await client.query('COMMIT')
    return { ok: true, order }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

### Pattern 3: pg_notify from Application Code

**What:** Call `SELECT pg_notify(channel, payload)` from within a transaction or standalone query.
**When to use:** After order confirmation (KDS-01), after item status change (CONS-06), after order auto-advance.

```typescript
// Source: existing listener.ts uses the same channel 'flashshell_events'
// The listener.ts dispatch() reads payload.channel to route to correct WS channel

// KDS new order event (within the transaction):
await client.query(
  `SELECT pg_notify('flashshell_events', $1::text)`,
  [JSON.stringify({
    channel: 'kds',
    event: 'new_order',
    orderId: order.id,
    createdAt: order.createdAt,
    items: order.items.map(i => ({ itemId: i.menuItemId, name: i.name, quantity: i.quantity }))
  })]
)

// Consumer item status event (from kdsPlugin, outside transaction — use db client):
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

### Pattern 4: Drizzle Schema Migration (item_status)

**What:** Add `itemStatusEnum` pgEnum and `itemStatus` column to `orderItems` via a new Drizzle migration.
**When to use:** Wave 0 of Phase 2 — before any handler code is written.

```typescript
// src/db/schema/orders.ts — additions only
export const itemStatusEnum = pgEnum('item_status', ['pending', 'preparing', 'ready'])

export const orderItems = pgTable('order_items', {
  // ...existing columns unchanged...
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
  // NEW:
  itemStatus: itemStatusEnum('item_status').notNull().default('pending')
})
```

After schema change: `bun run db:generate` then `bun run db:migrate`.

### Anti-Patterns to Avoid

- **Using `db` (Drizzle neon-http) for SELECT FOR UPDATE:** The HTTP-based Neon client cannot hold persistent connections required for row locks. All `SELECT FOR UPDATE` queries MUST use `pg.Pool` on `DATABASE_URL`.
- **Calling pg_notify outside transaction for order creation:** The notify and the commit must be atomic. If notify fires before COMMIT, the KDS may try to fetch an order that doesn't exist yet. Call `pg_notify` inside the transaction, immediately before COMMIT.
- **Separate pg.Client per request:** `pg.Client` is for single long-lived connections (the LISTEN hub). For transactional request handlers, use `pg.Pool` + `client.connect()` + `client.release()`.
- **Not releasing pg pool client on error:** Always use try/finally to call `client.release()`, even on transaction rollback.
- **Calling requireRole before authPlugin:** requireRole derives from the `user` context set by the `auth` macro. The chain must be `.use(authPlugin).use(requireRole(...))` — authPlugin first.
- **Forgetting `{ auth: true }` on route options:** The authPlugin macro is opt-in. Routes without `{ auth: true }` will not resolve `user` and will not be protected.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Request body validation | Custom validator | `t.Object({...})` TypeBox via Elysia | Elysia auto-validates and returns 422; edge cases around nulls/coercion handled |
| Role enforcement | Inline `if (user.role !== 'chef')` in handlers | `requireRole('chef')` plugin (already built) | Consistent 403 shape; scoped to parent; reusable |
| WS fan-out | Custom broadcast loop | `dispatch()` from `ws/listener.ts` (already built) | Handles channel registry, per-socket error isolation; already wired to pg_notify |
| Concurrent stock check | Application-level mutex | `SELECT FOR UPDATE` on ingredients rows | DB-level lock is the only correct solution for distributed/concurrent requests |
| pg_notify serialization | Custom binary protocol | `JSON.stringify` into `SELECT pg_notify(channel, $1::text)` | pg_notify payload is a text string; JSON is the established project pattern |

**Key insight:** The entire real-time fan-out infrastructure (pg_notify → LISTEN → dispatch → WS send) was built in Phase 1 and is verified working. Phase 2 only needs to call `pg_notify` from the right places — no new real-time plumbing.

---

## Common Pitfalls

### Pitfall 1: Neon HTTP Client Cannot Acquire Row Locks
**What goes wrong:** `db.select().from(ingredients).for('update')` throws or silently fails because the `@neondatabase/serverless` HTTP driver does not support session-level PostgreSQL features like row locking.
**Why it happens:** HTTP connections are stateless; each query is an independent HTTP request to the Neon pooler. `BEGIN`/`FOR UPDATE` require a persistent session.
**How to avoid:** Use `pg.Pool` with `DATABASE_URL` for ALL transactional code in `createOrder`. Keep `db` (Drizzle neon-http) for reads and simple inserts.
**Warning signs:** If you see "cannot use FOR UPDATE" errors or `BEGIN` returning without effect, the wrong client is being used.

### Pitfall 2: pg_notify Payload Size Limit
**What goes wrong:** `pg_notify` payloads larger than 8000 bytes are silently truncated by PostgreSQL, causing the listener to receive malformed JSON.
**Why it happens:** PostgreSQL imposes an 8000-byte limit on NOTIFY payloads.
**How to avoid:** Keep order payloads compact — the spec embeds only `{ itemId, name, quantity }` per item. Do not include descriptions, images, or large text fields. For very large orders (many items), consider embedding only IDs and letting the KDS do a follow-up GET (though CONTEXT.md specifies full embed — keep items array ≤ ~100 items to stay safe).
**Warning signs:** KDS receives `SyntaxError` on JSON.parse of notification; payload field appears cut off.

### Pitfall 3: Item Status Query on Non-Indexed Column
**What goes wrong:** `SELECT * FROM order_items WHERE order_id=$1` is fast (fk is indexed by reference constraint). But `WHERE item_status='pending'` without an index is a full table scan on large datasets.
**Why it happens:** New `item_status` column has no index by default.
**How to avoid:** Add a composite index on `(order_id, item_status)` in the migration. The KDS auto-advance check queries `WHERE order_id=$1` so the order_id prefix is the high-cardinality key.
**Warning signs:** Slow KDS queries as order volume grows.

### Pitfall 4: Auto-advance Check Race Condition
**What goes wrong:** Two concurrent PATCH requests for the last two items of an order both see "one item remaining" and both attempt to advance the order, leading to duplicate `ready_for_pickup` transitions and two `pg_notify` fires to `logistics`.
**Why it happens:** The "are all items ready?" check and the order status update are two separate queries without locking.
**How to avoid:** Perform the auto-advance check and update in a single `UPDATE orders SET status='ready_for_pickup' WHERE id=$1 AND status='preparing' AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=$1 AND item_status != 'ready') RETURNING id`. If the UPDATE returns 0 rows, another request already advanced the order.
**Warning signs:** Duplicate `new_order` events on KDS, duplicate logistics notifications.

### Pitfall 5: WS Channel Name Consistency
**What goes wrong:** Handler calls `dispatch('order:abc-123', ...)` but consumer subscribed to `order:ABC-123` (case mismatch) or `orders:abc-123` (plural vs singular).
**Why it happens:** Channel names are free-form strings; the registry is an exact-match Map.
**How to avoid:** Define a single channel name formatter: `` `order:${orderId}` `` — lowercase, singular, colon-separated. Use this exact format everywhere (subscribe call, dispatch call).
**Warning signs:** Consumer never receives status events despite handler confirming pg_notify fired.

### Pitfall 6: authPlugin Macro Scope
**What goes wrong:** Routes in `consumerPlugin` or `kdsPlugin` don't have access to `{ user }` even though `authPlugin` is used.
**Why it happens:** Elysia encapsulation — macros are `local` scope by default and don't propagate to parent. But `authPlugin` uses `{ as: 'scoped' }` on its macro, meaning the plugin must be `.use()`d on the SAME instance that defines the routes.
**How to avoid:** `consumerPlugin.use(authPlugin)` before declaring routes that use `{ auth: true }`. Verified working pattern from Phase 1.
**Warning signs:** TypeScript error: `user` not found on context, or runtime 500 because `user` is undefined.

---

## Code Examples

Verified patterns from project source:

### Auth-Protected Route with Role Guard
```typescript
// Source: src/plugins/auth/index.ts + require-role.ts (Phase 1 verified)
export const kdsPlugin = new Elysia({ name: 'kds', prefix: '/kds' })
  .use(authPlugin)
  .use(requireRole('chef'))
  .get('/orders', ({ user }) => getActiveOrders(), { auth: true })
```

### pg_notify via Drizzle sql tag (simple, outside transaction)
```typescript
// Source: pattern from existing listener.ts pg_notify usage
import { sql } from 'drizzle-orm'
import { db } from '../../db/client'

await db.execute(
  sql`SELECT pg_notify('flashshell_events', ${JSON.stringify(payload)}::text)`
)
```

### TypeBox body validation with TypeScript type extraction
```typescript
// Source: elysiajs skill references/validation.md
import { t } from 'elysia'

const CreateOrderBody = t.Object({
  items: t.Array(t.Object({
    menuItemId: t.String({ format: 'uuid' }),
    quantity: t.Integer({ minimum: 1 })
  }), { minItems: 1 })
})

type CreateOrderBody = typeof CreateOrderBody.static
```

### Dispatch to consumer WS channel
```typescript
// Source: src/plugins/ws/listener.ts dispatch() signature (Phase 1 verified)
import { dispatch } from '../ws/listener'

// Called after item status update persisted:
dispatch(`order:${orderId}`, {
  channel: `order:${orderId}`,
  event: 'item_status_changed',
  orderId,
  itemId,
  status: newStatus
})
```

### Drizzle query for active menu items
```typescript
// Source: drizzle-orm docs; menuItems schema confirmed in src/db/schema/menu.ts
import { db } from '../../db/client'
import { menuItems } from '../../db/schema'
import { eq } from 'drizzle-orm'

const activeMenu = await db
  .select()
  .from(menuItems)
  .where(eq(menuItems.isAvailable, true))
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Redis pub/sub for real-time | Neon LISTEN/NOTIFY | Project decision | No Redis dependency; pg client already present |
| Stripe payments in Phase 2 | Auto-confirm in Phase 2; Stripe in Phase 5 | CONTEXT.md decision | POST /consumer/orders advances to `confirmed` directly; Phase 5 adds Payment Intent |
| Separate pg_notify call after commit | pg_notify inside transaction | CONTEXT.md + Pitfall research | Guarantees atomicity; KDS never receives event for non-existent order |

**Deprecated/outdated in this context:**
- Stripe in Phase 2: out of scope; `payment_intents` table exists but is unused until Phase 5
- `pending` order status visible to KDS: KDS watches `confirmed` only

---

## Open Questions

1. **DATABASE_URL vs DATABASE_DIRECT_URL for pg.Pool**
   - What we know: `DATABASE_URL` is the pooled Neon URL; `DATABASE_DIRECT_URL` is the direct connection used by migrate + listener.
   - What's unclear: Neon's PgBouncer pooler in transaction mode should support `SELECT FOR UPDATE`. The project already uses `DATABASE_URL` for all queries. Using `pg.Pool` with `DATABASE_URL` (pooled) is likely fine because transaction mode preserves session state within a single `BEGIN`/`COMMIT` transaction.
   - Recommendation: Use `DATABASE_URL` for `pg.Pool`. If `FOR UPDATE` fails with a pooler error, switch the pool to use `DATABASE_DIRECT_URL`. Document in code.

2. **Drizzle `sql` tag vs raw `client.query()` for pg_notify outside transactions**
   - What we know: `db.execute(sql\`SELECT pg_notify(...)\`)` works with the Drizzle neon-http client for non-transactional notifies (item status updates, availability changes).
   - What's unclear: Whether Drizzle's `sql` template correctly serializes the JSON string argument.
   - Recommendation: Use `client.query('SELECT pg_notify($1, $2)', ['flashshell_events', JSON.stringify(payload)])` inside transactions (clarity). Use `db.execute(sql\`...\`)` outside transactions (consistency with rest of codebase). Both are valid.

3. **requireRole 403 test coverage (carry-forward from Phase 1)**
   - What we know: The placeholder test `expect(true).toBe(true)` in auth.test.ts is unresolved.
   - What's unclear: Whether Phase 2 plans should include an integration test that signs in as a customer and verifies 403 on a chef-only route.
   - Recommendation: Include a unit test in kdsPlugin tests that builds a minimal app with a mocked user context returning `role: 'customer'` to verify 403 path without a live DB.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (built-in Bun test runner) |
| Config file | none — `bun test` discovers `test/**/*.test.ts` automatically |
| Quick run command | `bun test test/plugins/consumer.test.ts test/plugins/kds.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONS-01 | GET /consumer/menu returns only isAvailable=true items | unit (mock db) | `bun test test/plugins/consumer.test.ts` | ❌ Wave 0 |
| CONS-02 | POST /consumer/orders creates order, returns full object with `confirmed` status | unit (mock db) | `bun test test/plugins/consumer.test.ts` | ❌ Wave 0 |
| CONS-03 | Two concurrent POSTs for last unit of stock: exactly one succeeds, one gets 409 | integration (requires live DB) | `bun test test/integration/order-concurrency.test.ts` | ❌ Wave 0 |
| CONS-06 | Consumer WS channel receives item_status_changed event after PATCH | unit (mock dispatch) | `bun test test/plugins/kds.test.ts` | ❌ Wave 0 |
| CONS-07 | GET /consumer/orders returns list for authenticated customer | unit (mock db) | `bun test test/plugins/consumer.test.ts` | ❌ Wave 0 |
| KDS-01 | pg_notify fires to 'kds' channel when order confirmed | unit (spy on dispatch) | `bun test test/plugins/consumer.test.ts` | ❌ Wave 0 |
| KDS-02 | PATCH /kds/orders/:id/items/:itemId with `preparing` updates item_status | unit (mock db) | `bun test test/plugins/kds.test.ts` | ❌ Wave 0 |
| KDS-03 | PATCH to `ready` on last item auto-advances order to ready_for_pickup | unit (mock db) | `bun test test/plugins/kds.test.ts` | ❌ Wave 0 |
| KDS-04 | Covered by KDS-03 auto-advance — no separate endpoint | (see KDS-03) | — | — |
| KDS-05 | PATCH /kds/menu/:itemId/availability toggles isAvailable; GET /consumer/menu reflects change | unit (mock db) | `bun test test/plugins/kds.test.ts` | ❌ Wave 0 |

**Note:** CONS-03 concurrency test requires a live Neon DB (cannot mock `SELECT FOR UPDATE` semantics). Mark as integration test; skip when `DATABASE_URL` is not set (same pattern as existing auth.test.ts).

### Sampling Rate
- **Per task commit:** `bun test test/plugins/consumer.test.ts test/plugins/kds.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/plugins/consumer.test.ts` — covers CONS-01, CONS-02, CONS-07, KDS-01
- [ ] `test/plugins/kds.test.ts` — covers CONS-06, KDS-02, KDS-03, KDS-05
- [ ] `test/integration/order-concurrency.test.ts` — covers CONS-03 (integration, requires DATABASE_URL)

---

## Sources

### Primary (HIGH confidence)
- Project source: `src/plugins/ws/listener.ts` — dispatch(), pg_notify channel topology confirmed
- Project source: `src/plugins/auth/index.ts` + `require-role.ts` — authPlugin macro + requireRole factory verified in Phase 1
- Project source: `src/db/schema/orders.ts` + `menu.ts` — existing schema; migration gaps identified
- Project source: `src/db/client.ts` — Drizzle neon-http client wiring confirmed
- Skill: `.agents/skills/elysiajs/SKILL.md` — Elysia plugin patterns, encapsulation rules, macro scoping
- Skill: `.agents/skills/elysiajs/references/websocket.md` — WS lifecycle, auth in beforeHandle
- Skill: `.agents/skills/elysiajs/references/testing.md` — bun:test patterns, module-level testing
- Skill: `.agents/skills/elysiajs/integrations/drizzle.md` — drizzle-typebox, TypeBox schema from Drizzle tables
- Phase 1 verification: `.planning/phases/01-foundation/01-VERIFICATION.md` — all INFRA requirements confirmed

### Secondary (MEDIUM confidence)
- PostgreSQL documentation: `SELECT FOR UPDATE` requires persistent connection (not HTTP); `pg_notify` 8000-byte payload limit — standard PostgreSQL behavior, consistent across versions
- `pg` v8.x API: `Pool.connect()` → `Client`, transaction via `BEGIN`/`COMMIT`/`ROLLBACK` — stable, unchanged for years

### Tertiary (LOW confidence)
- Neon pooler (PgBouncer in transaction mode) compatibility with `SELECT FOR UPDATE`: transaction mode should preserve session state within a transaction, but Neon's specific pooler version behavior is not verified from official docs in this session. Flag as risk; test in Wave 0.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use and verified in Phase 1
- Architecture: HIGH — plugin pattern is established; pg.Pool for transactions is standard PostgreSQL practice
- Pitfalls: HIGH for items 1, 2, 5, 6 (verified from code); MEDIUM for items 3, 4 (reasoned from PostgreSQL/concurrency fundamentals)
- Validation architecture: HIGH — bun:test confirmed working in Phase 1; test file patterns match existing test/ structure

**Research date:** 2026-03-16
**Valid until:** 2026-04-16 (stable stack; Elysia releases frequently but plugin API is stable)
