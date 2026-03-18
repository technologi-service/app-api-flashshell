# Phase 4: Admin and Control - Research

**Researched:** 2026-03-18
**Domain:** PostgreSQL triggers, Drizzle ORM migrations, Elysia plugin pattern, WebSocket LISTEN/NOTIFY, SQL aggregates
**Confidence:** HIGH

---

## Summary

Phase 4 delivers four capabilities entirely within the existing stack: a PostgreSQL trigger for automatic
stock deduction on order confirmation (CTRL-01), a WebSocket low-stock alert fired from that same trigger
via pg_notify (CTRL-02), an admin active-order dashboard over the existing `control` WebSocket channel
(CTRL-03), and a date-ranged cash-flow report that aggregates confirmed revenue against stock cost consumed
(CTRL-04).

The critical architectural constraint is CTRL-01's explicit requirement that stock deduction happens in
the database trigger, not in application code. This means the migration for this phase must include both a
`BEFORE UPDATE` trigger on `orders` and an `AFTER UPDATE` trigger (or the same trigger, extended) that
calls `pg_notify` for the low-stock alert. All other requirements (active-order listing, cash-flow query)
are straightforward Elysia service + route implementations mirroring the patterns established in Phases 2
and 3.

No new npm packages are required. The `control` WebSocket channel already exists in the listener
topology defined in `src/plugins/ws/index.ts`. The existing `pg` pool pattern (DATABASE_DIRECT_URL,
max:5) is correct for any transactional work in this phase.

**Primary recommendation:** Write a single Drizzle raw-SQL migration that contains the stock-deduction
trigger function and the low-stock pg_notify, then implement `controlPlugin` with two routes and a
service that reads the `control` channel events. No new dependencies needed.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTRL-01 | Stock of ingredients decremented automatically when order transitions to `confirmed` — trigger in DB, no application logic | PostgreSQL `AFTER UPDATE ON orders` trigger; joins `order_items` and `menu_item_ingredients` to decrement `ingredients.stock_quantity` |
| CTRL-02 | WebSocket alert to admin when ingredient stock falls below `critical_threshold` | Same trigger function calls `pg_notify('flashshell_events', ...)` after deduction; existing `control` channel in listener.ts dispatches it to subscribed admin |
| CTRL-03 | Admin can view all orders with status not in `{delivered, cancelled}` in real time | `GET /control/orders/active` service query + existing pg_notify `control` channel events already emitted by logistics/KDS phases |
| CTRL-04 | Admin cash-flow report: confirmed revenue vs stock cost consumed for a date range | `GET /control/reports/cashflow?from=DATE&to=DATE` — two SQL aggregates joined in a single query |
</phase_requirements>

---

## Standard Stack

### Core — no new packages needed

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------------------|---------|--------------|
| elysia | latest (1.4.x) | Plugin pattern for `controlPlugin` | Project hard constraint |
| drizzle-orm | ^0.45.1 | Schema types, sql`` template, db.execute() | Project hard constraint |
| drizzle-kit | ^0.31.9 | Generating migration file from raw SQL | Project hard constraint |
| pg | ^8.20.0 | txPool for transactional queries | Already in use; direct connection required for FOR UPDATE |
| @neondatabase/serverless | ^1.0.2 | Pooled HTTP client for read queries | Already in use |

### No New Installations Required

All Phase 4 work fits within the current dependency set. The pg_notify/LISTEN pattern, txPool pattern,
Drizzle migration pattern, and Elysia plugin pattern are already proven in Phases 1-3.

**Installation:** none

---

## Architecture Patterns

### Recommended Project Structure

```
src/plugins/control/
├── index.ts      # Elysia plugin: new Elysia({ name: 'control', prefix: '/control' })
├── service.ts    # getActiveOrders(), getCashflowReport(from, to)
└── model.ts      # TypeBox schemas: CashflowQuery, ActiveOrdersResponse, CashflowResponse

src/db/migrations/
└── 0004_stock_trigger.sql    # trigger function + AFTER UPDATE trigger + pg_notify
```

### Pattern 1: Drizzle Raw-SQL Migration for PostgreSQL Trigger

**What:** Drizzle Kit cannot generate trigger DDL from schema TS files — triggers must be written as
raw SQL in a migration file using `drizzle-kit generate --custom` or by manually placing a `.sql`
file in the migrations directory and registering it in `meta/_journal.json`.

**When to use:** Any time a PostgreSQL capability (trigger, function, index, partial index) cannot be
expressed in Drizzle schema DSL.

**Established pattern in project:** Migrations `0002_add_item_status.sql` and `0003_add_courier_columns.sql`
are already hand-authored SQL files. The `bun run db:migrate` script applies all `.sql` files in order.

**Example — stock deduction trigger:**
```sql
-- 0004_stock_trigger.sql
CREATE OR REPLACE FUNCTION deduct_stock_on_confirm()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only fire when transitioning INTO 'confirmed'
  IF NEW.status = 'confirmed' AND OLD.status != 'confirmed' THEN
    UPDATE ingredients i
    SET stock_quantity = i.stock_quantity - (mii.quantity_used * oi.quantity),
        updated_at = NOW()
    FROM order_items oi
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    WHERE oi.order_id = NEW.id
      AND mii.ingredient_id = i.id;

    -- Notify admin for any ingredient now below critical_threshold
    PERFORM pg_notify(
      'flashshell_events',
      row_to_json(t)::text
    )
    FROM (
      SELECT
        'control'        AS channel,
        'low_stock_alert' AS event,
        i.id             AS ingredient_id,
        i.name           AS ingredient_name,
        i.stock_quantity  AS current_stock,
        i.critical_threshold
      FROM ingredients i
      JOIN menu_item_ingredients mii ON mii.ingredient_id = i.id
      JOIN order_items oi ON oi.menu_item_id = mii.menu_item_id
      WHERE oi.order_id = NEW.id
        AND i.stock_quantity < i.critical_threshold
    ) t;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deduct_stock_on_confirm
  AFTER UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION deduct_stock_on_confirm();
```

**Key detail:** The trigger uses `AFTER UPDATE` (not BEFORE) so `NEW.id` is visible and `order_items`
are already committed. It guards on `OLD.status != 'confirmed'` to be idempotent — re-running an
UPDATE that leaves status as `confirmed` does not double-deduct.

### Pattern 2: Drizzle `meta/_journal.json` Registration

When adding a hand-authored migration, it must be appended to `src/db/migrations/meta/_journal.json`
so `drizzle-kit` knows the migration exists and `bun run db:migrate` applies it.

**Example journal entry to append:**
```json
{
  "idx": 4,
  "version": "7",
  "when": 1710720000000,
  "tag": "0004_stock_trigger",
  "breakpoints": true
}
```

### Pattern 3: controlPlugin — mirrors logisticsPlugin structure

```typescript
// src/plugins/control/index.ts
export const controlPlugin = new Elysia({ name: 'control', prefix: '/control' })
  .use(authPlugin)
  .use(requireRole('admin'))
  .get('/orders/active', () => getActiveOrders(), { auth: true })
  .get(
    '/reports/cashflow',
    async ({ query }) => getCashflowReport(query.from, query.to),
    { auth: true, query: CashflowQuery }
  )
```

### Pattern 4: Active Orders — existing pg_notify events already cover CTRL-03 real-time

Prior phases already emit to the `control` channel:
- `order_picked_up` — from `logistics/service.ts` advanceOrderStatus
- `order_delivered` — from `logistics/service.ts` advanceOrderStatus
- KDS phase emits `order_ready`, `order_status_changed` to `kds` channel

Phase 4 must ensure `order_confirmed` is emitted to `control` when order transitions to `confirmed`.
Currently the consumer `createOrder` service emits `kds` channel only. The controlPlugin or the
trigger must fill this gap.

**Decision:** The trigger already has access to the order transition event. The trigger should also
emit `order_confirmed` to the `control` channel. This keeps all admin events in the trigger, consistent
with the "no application-layer deduction" constraint.

### Pattern 5: Cash Flow Query

```sql
SELECT
  SUM(o.total_amount)::numeric   AS total_revenue,
  COALESCE(SUM(
    oi.quantity::numeric * mii.quantity_used::numeric * i.cost_per_unit::numeric
  ), 0)                           AS total_stock_cost
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
JOIN ingredients i ON i.id = mii.ingredient_id
WHERE o.status = 'confirmed'
  AND o.created_at >= $1::timestamptz
  AND o.created_at <  $2::timestamptz
```

Use `db.execute(sql`...`)` with Drizzle's sql template for parameterized dates. Date params arrive as
ISO strings from the query string; cast to `timestamptz` in the query.

### Anti-Patterns to Avoid

- **Application-layer stock deduction:** CTRL-01 explicitly forbids deducting stock from service.ts or
  any HTTP handler. The trigger is the only allowed deduction path.
- **Using pooled Neon connection for trigger testing:** Triggers fire server-side; no application pool
  issue. But any `txPool` queries in Phase 4 service code must still use `DATABASE_DIRECT_URL`.
- **Double-deduction guard omitted:** Without the `OLD.status != 'confirmed'` guard, any UPDATE
  that touches an already-confirmed order (e.g., status changes to `preparing`) would re-deduct stock.
- **`BEFORE UPDATE` instead of `AFTER UPDATE`:** A BEFORE trigger sees the new row but the `order_items`
  join still works because items are committed. However AFTER is conventional and safer for side-effect
  work (pg_notify, stock writes affecting other tables).
- **Forgetting `PERFORM` for pg_notify in PL/pgSQL:** In PL/pgSQL, `SELECT` expressions that don't
  return a value must use `PERFORM`, not `SELECT`. `pg_notify()` returns void — use `PERFORM pg_notify(...)`.
- **Skipping idempotency on trigger:** Drizzle `CREATE OR REPLACE FUNCTION` + `CREATE TRIGGER IF NOT EXISTS`
  (PostgreSQL 14+) makes the migration re-runnable. Use `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`
  for compatibility with PostgreSQL 13.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic stock deduction on status change | Application UPDATE in service.ts | PostgreSQL AFTER UPDATE trigger | CTRL-01 requirement; trigger is atomic with the order row update, no race condition possible |
| Low-stock threshold check | Polling cron job | pg_notify inside the trigger | Trigger fires immediately after deduction; cron adds latency and requires Redis or scheduler |
| Active-order real-time updates | Polling GET endpoint | Existing `control` WebSocket channel + pg_notify | All prior phase transitions already emit to `control`; no new real-time infrastructure needed |
| Date arithmetic for reports | Custom parsing | PostgreSQL `timestamptz` casts + `BETWEEN` | DB handles timezone, overflow, leap years correctly |

**Key insight:** The PostgreSQL trigger is the right tool because it is transactional with the UPDATE
that triggers it — if the UPDATE rolls back, the stock deduction rolls back too. Application-layer
deduction cannot provide this guarantee without wrapping in the same transaction.

---

## Common Pitfalls

### Pitfall 1: Trigger double-fires on subsequent status updates
**What goes wrong:** Trigger fires again when status changes from `confirmed` → `preparing`, re-deducting
stock a second time.
**Why it happens:** The trigger is `AFTER UPDATE ON orders FOR EACH ROW` — it fires on every UPDATE
to any column on any row.
**How to avoid:** Guard with `IF NEW.status = 'confirmed' AND OLD.status != 'confirmed'`. This ensures
the deduction only fires on the specific confirmed→ transition.
**Warning signs:** Stock quantities going negative unexpectedly during normal order processing.

### Pitfall 2: `PERFORM` vs `SELECT` in PL/pgSQL for pg_notify
**What goes wrong:** `SELECT pg_notify(...)` in a PL/pgSQL function body causes a syntax error or
silently discards the result (depending on context).
**Why it happens:** PL/pgSQL requires `PERFORM` for expressions whose return value is discarded.
`SELECT` in PL/pgSQL expects to return results into a variable or loop.
**How to avoid:** Always `PERFORM pg_notify('flashshell_events', payload)` inside trigger functions.
**Warning signs:** `ERROR: query has no destination for result data` during migration.

### Pitfall 3: Migration not registered in `_journal.json`
**What goes wrong:** `bun run db:migrate` skips the new `.sql` file because it is not in the journal.
**Why it happens:** Drizzle's migrate runner uses the journal as the canonical list of applied migrations.
**How to avoid:** Append the entry to `src/db/migrations/meta/_journal.json` as part of the migration
task. The `idx` must be sequential (current max is 3, so next is 4).
**Warning signs:** Migration runs but trigger does not exist in the database.

### Pitfall 4: `row_to_json` serialization includes unexpected types
**What goes wrong:** `stock_quantity` in the pg_notify payload is a PostgreSQL `numeric` string, not a
JavaScript number. The admin WebSocket client receives `"0.000"` instead of `0`.
**Why it happens:** `row_to_json` serializes numeric columns as strings for precision safety.
**How to avoid:** Either cast in the SQL `SELECT i.stock_quantity::float` or document the wire type and
parse on the client. Consistent with existing patterns — `total_amount` is already a string in the API.
**Warning signs:** Frontend type errors when comparing `current_stock < critical_threshold` in JS.

### Pitfall 5: Cash flow query returns NULL when no orders match
**What goes wrong:** `GET /control/reports/cashflow?from=...&to=...` returns `{ total_revenue: null }`
when no confirmed orders exist in the range.
**Why it happens:** SQL `SUM()` on an empty set returns NULL.
**How to avoid:** Wrap with `COALESCE(SUM(...), 0)` for both revenue and cost columns.
**Warning signs:** Cashflow response body fails TypeBox validation if schema expects `t.Number()` and
receives `null`.

### Pitfall 6: pg_notify payload > 8000 bytes
**What goes wrong:** pg_notify silently drops notifications with payloads over 8000 bytes.
**Why it happens:** PostgreSQL has an 8000-byte limit on NOTIFY payloads.
**How to avoid:** The low-stock alert payload is small (ingredient ID, name, two numeric values) — well
within limits. The `order_confirmed` event should only include `orderId`, not the full order. If a future
event needs full data, emit only the ID and let the client re-fetch.
**Warning signs:** Admin WebSocket channel receives no notification despite trigger firing (check
PostgreSQL logs for `pg_notify` warnings).

---

## Code Examples

Verified patterns from project codebase:

### pg_notify inside a pg.Client transaction (existing pattern from logistics/service.ts)
```typescript
// Pattern: pg_notify emitted inside raw pg transaction
await client.query(
  `SELECT pg_notify('flashshell_events', $1::text)`,
  [JSON.stringify({ channel: 'control', event: 'order_confirmed', orderId })]
)
```

### db.execute with sql template for date-parameterized query (established pattern)
```typescript
// Pattern: Drizzle sql template with parameters
const result = await db.execute(sql`
  SELECT
    COALESCE(SUM(o.total_amount), 0)::text          AS total_revenue,
    COALESCE(SUM(
      oi.quantity::numeric * mii.quantity_used::numeric * i.cost_per_unit::numeric
    ), 0)::text                                      AS total_stock_cost
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
  JOIN ingredients i ON i.id = mii.ingredient_id
  WHERE o.status = 'confirmed'
    AND o.created_at >= ${from}::timestamptz
    AND o.created_at <  ${to}::timestamptz
`)
const rows = (result as any).rows ?? (Array.isArray(result) ? result : [])
```

### requireRole guard on admin plugin (established pattern from logisticsPlugin)
```typescript
export const controlPlugin = new Elysia({ name: 'control', prefix: '/control' })
  .use(authPlugin)
  .use(requireRole('admin'))
  // routes...
```

### Active orders query (mirrors getActiveOrders in kds/service.ts)
```typescript
// Active = NOT in {delivered, cancelled}
const result = await db.execute(sql`
  SELECT o.id, o.status, o.total_amount, o.delivery_address,
         o.created_at, o.updated_at,
         oi.quantity, mi.name AS item_name
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN menu_items mi ON mi.id = oi.menu_item_id
  WHERE o.status NOT IN ('delivered', 'cancelled')
  ORDER BY o.created_at ASC
`)
```

---

## Schema: What Already Exists (No New Tables Needed)

Phase 4 requires **no new tables**. The existing schema already has everything:

| Table | Relevant Columns | Used By |
|-------|-----------------|---------|
| `ingredients` | `stock_quantity`, `critical_threshold`, `cost_per_unit` | CTRL-01 trigger deduction; CTRL-02 threshold check; CTRL-04 cost aggregate |
| `menu_item_ingredients` | `ingredient_id`, `menu_item_id`, `quantity_used` | JOIN bridge for trigger and cash flow |
| `order_items` | `order_id`, `menu_item_id`, `quantity`, `unit_price` | JOIN bridge for trigger and cash flow |
| `orders` | `status`, `total_amount`, `created_at` | Trigger condition; CTRL-03 active filter; CTRL-04 revenue sum |

The migration for this phase only adds:
1. The trigger function `deduct_stock_on_confirm()`
2. The trigger `trg_deduct_stock_on_confirm` on `orders`

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Drizzle `sql.raw()` | Drizzle `sql` template tag with interpolations | Drizzle 0.28+ | Parameterized queries, no injection risk |
| `SELECT pg_notify(...)` in PL/pgSQL | `PERFORM pg_notify(...)` | Always | Correct PL/pgSQL; `SELECT` without INTO is an error |
| Manual journal editing | `drizzle-kit generate --custom` (Drizzle 0.30+) | Drizzle 0.30 | Generates journal entry automatically for custom SQL |

**Note on drizzle-kit generate --custom:** This command exists in Drizzle Kit 0.30+ and creates an
empty SQL file with the journal entry pre-populated. This is the preferred approach over manual journal
editing. Project has drizzle-kit 0.31.9 — this command is available.

```bash
bun run drizzle-kit generate --custom --name stock_trigger
# Creates: src/db/migrations/0004_stock_trigger.sql (empty) + journal entry
# Then fill in the SQL manually
```

---

## Open Questions

1. **`order_confirmed` event on control channel**
   - What we know: Logistics phase emits `order_picked_up` and `order_delivered` to `control`.
     Consumer `createOrder` currently only emits to `kds` channel.
   - What's unclear: Should the trigger emit `order_confirmed` to `control`, or should application
     code in `consumer/service.ts` emit it?
   - Recommendation: Have the trigger emit `order_confirmed` to `control` alongside the stock
     deduction. This keeps admin real-time updates entirely in the trigger and avoids splitting
     responsibility. The trigger fires atomically with the UPDATE that causes confirmation.

2. **Who transitions order to `confirmed` in the current codebase?**
   - What we know: Phase 2 created orders with `pending` status. `confirmed` transition is currently
     only wired to Phase 5 (Stripe webhook). Since Phase 5 is not yet built, `confirmed` status
     transitions do not yet happen in production.
   - What's unclear: How should CTRL-01/CTRL-02/CTRL-03 be tested end-to-end without Phase 5?
   - Recommendation: The trigger is unconditional — it fires whenever any UPDATE on `orders` sets
     `status = 'confirmed'`. For integration testing, a seed script or direct SQL UPDATE can be used
     to confirm an order and verify deduction. The trigger does not depend on Phase 5.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | bun:test (built-in) |
| Config file | none — bun discovers `test/**/*.ts` automatically |
| Quick run command | `bun test test/plugins/control.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CTRL-01 | Trigger deducts stock when order status → `confirmed` | integration (live DB) | `bun test test/integration/stock-trigger.test.ts` | ❌ Wave 0 |
| CTRL-01 | Trigger does NOT deduct on non-confirmed transitions | integration (live DB) | `bun test test/integration/stock-trigger.test.ts` | ❌ Wave 0 |
| CTRL-02 | pg_notify `low_stock_alert` emitted when stock < threshold after deduction | integration (live DB) | `bun test test/integration/stock-trigger.test.ts` | ❌ Wave 0 |
| CTRL-03 | `GET /control/orders/active` returns orders not in `{delivered, cancelled}` | unit (mock service) | `bun test test/plugins/control.test.ts` | ❌ Wave 0 |
| CTRL-03 | `GET /control/orders/active` returns 403 for non-admin role | unit (mock service) | `bun test test/plugins/control.test.ts` | ❌ Wave 0 |
| CTRL-04 | `GET /control/reports/cashflow` returns `total_revenue` and `total_stock_cost` | unit (mock service) | `bun test test/plugins/control.test.ts` | ❌ Wave 0 |
| CTRL-04 | `GET /control/reports/cashflow` returns 422 for missing date params | unit | `bun test test/plugins/control.test.ts` | ❌ Wave 0 |
| CTRL-04 | `GET /control/reports/cashflow` returns zeros when no confirmed orders in range | unit (mock service) | `bun test test/plugins/control.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test test/plugins/control.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `test/plugins/control.test.ts` — unit tests for CTRL-03, CTRL-04 (mock service pattern)
- [ ] `test/integration/stock-trigger.test.ts` — integration tests for CTRL-01, CTRL-02 (requires live DB; follows `test/integration/order-concurrency.test.ts` pattern)

Note: The stock trigger integration test is the only test in this project that tests database-side
behavior. It cannot be mocked — it requires a live Neon connection with `DATABASE_DIRECT_URL` and a
real UPDATE on the `orders` table. This is acceptable; the project already has live-DB integration
tests in `test/integration/`.

---

## Sources

### Primary (HIGH confidence)
- Project codebase — `src/plugins/ws/listener.ts`, `src/plugins/logistics/service.ts`,
  `src/plugins/kds/service.ts`, `src/db/schema/menu.ts`, `src/db/schema/orders.ts` — all inspected directly
- `src/db/migrations/0000_neat_barracuda.sql` through `0003_add_courier_columns.sql` — migration
  pattern and journal structure confirmed
- `.agents/skills/elysiajs/SKILL.md` — plugin pattern, requireRole guard, method chaining rules
- `.planning/STATE.md` decisions log — DATABASE_DIRECT_URL pattern, pg.Pool pattern, plugin naming
- `.planning/REQUIREMENTS.md` — CTRL-01 through CTRL-04 requirements confirmed

### Secondary (MEDIUM confidence)
- PostgreSQL documentation on trigger timing (AFTER vs BEFORE), `PERFORM` keyword in PL/pgSQL,
  `FOR EACH ROW` semantics — standard PostgreSQL 14+ behavior; consistent with project's Neon
  (PostgreSQL 16) target
- Drizzle Kit 0.31.9 `generate --custom` command — confirmed available in 0.30+ changelog

### Tertiary (LOW confidence)
- pg_notify 8000-byte payload limit — widely documented PostgreSQL constraint; LOW only because
  exact Neon behavior on serverless has not been tested in this project

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all existing packages are confirmed in package.json
- Architecture: HIGH — trigger pattern, plugin structure, and pg_notify approach all verified
  against live codebase
- Pitfalls: HIGH — double-deduction and PERFORM pitfalls are well-known PostgreSQL patterns;
  journal registration pitfall observed in existing migrations

**Research date:** 2026-03-18
**Valid until:** 2026-04-18 (stable stack; Drizzle and Elysia may update but patterns are stable)
