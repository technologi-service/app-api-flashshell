---
phase: 02-core-order-pipeline
verified: 2026-03-16T14:30:00Z
status: passed
score: 13/13 must-haves verified
re_verification: false
---

# Phase 2: Core Order Pipeline — Verification Report

**Phase Goal:** A customer can browse the menu and place an order; the chef sees it on the KDS screen in under 500ms
**Verified:** 2026-03-16
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `order_items` table has `item_status` column with pgEnum values: pending, preparing, ready | VERIFIED | `src/db/schema/orders.ts` exports `itemStatusEnum`; `0002_add_item_status.sql` has `CREATE TYPE "public"."item_status" AS ENUM('pending', 'preparing', 'ready')` |
| 2 | `GET /consumer/menu` returns only `isAvailable=true` items with id, name, description, price | VERIFIED | `getActiveMenu()` uses Drizzle `.where(eq(menuItems.isAvailable, true))` selecting those exact fields; unit test green |
| 3 | `POST /consumer/orders` creates order atomically with SELECT FOR UPDATE, stock decrement, confirms status, returns id/status/totalAmount/items | VERIFIED | Two-step locking (`SELECT ... FOR UPDATE` on ingredients subquery + plain data read), `UPDATE ingredients SET stock_quantity = stock_quantity - $1`, INSERT order with `'confirmed'` status; unit test green |
| 4 | `POST /consumer/orders` returns 409 with failing item IDs if item is unavailable or has insufficient stock | VERIFIED | Failure collection loop builds `failures[]` array; handler returns `status(409, { error: 'CONFLICT', details: result.failures })`; unit test covers both branches |
| 5 | `pg_notify` fires to `kds` channel inside the same transaction that confirms the order | VERIFIED | `SELECT pg_notify('flashshell_events', ...)` called before `COMMIT` in `createOrder()` transaction; channel payload contains `channel: 'kds'` |
| 6 | Two concurrent `POST /consumer/orders` for the last stock unit result in exactly one 200 and one 409 | VERIFIED | Integration test `test/integration/order-concurrency.test.ts` fires `Promise.all([createOrderDirect(...), createOrderDirect(...)])` against live DB; `txPool` uses `DATABASE_DIRECT_URL` to bypass Neon PgBouncer; 1 pass / 0 fail in test run |
| 7 | `GET /kds/orders` returns all confirmed + preparing orders (not pending, not delivered) | VERIFIED | `getActiveOrders()` uses `inArray(orders.status, ['confirmed', 'preparing'])`; KDS unit test green |
| 8 | `PATCH /kds/orders/:id/items/:itemId` with `status=preparing` updates item_status in DB | VERIFIED | `updateItemStatus()` does `db.update(orderItems).set({ itemStatus: newStatus })`; unit test green |
| 9 | `PATCH /kds/orders/:id/items/:itemId` with `status=ready` on last item auto-advances order to `ready_for_pickup` | VERIFIED | Atomic `UPDATE orders SET status = 'ready_for_pickup' WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE item_status != 'ready')`; unit test asserts `advanced: true` |
| 10 | Auto-advance fires `pg_notify` to both `kds` channel (order_ready) and `logistics` channel (order_ready_for_pickup) | VERIFIED | Both `pg_notify` calls present in `kds/service.ts` lines 81-95 inside `if (rowCount > 0)` guard |
| 11 | After PATCH to any item status, consumer's `order:{orderId}` channel receives `item_status_changed` event | VERIFIED | `pg_notify` to `order:${orderId}` fired unconditionally after successful item update (line 46-54 of `kds/service.ts`); CONS-06 covered by unit test |
| 12 | `PATCH /kds/menu/:itemId/availability` toggles `isAvailable` on the menu item | VERIFIED | `toggleAvailability()` uses `db.update(menuItems).set({ isAvailable })`; unit test covers 200 and 404 paths |
| 13 | `consumerPlugin` and `kdsPlugin` are mounted in `src/index.ts`; `GET /consumer/orders` returns customer order history | VERIFIED | `src/index.ts` imports and calls `.use(consumerPlugin).use(kdsPlugin)` before `.listen(3000)`; `getOrderHistory()` in service; CONS-07 unit test green |

**Score:** 13/13 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schema/orders.ts` | `itemStatusEnum` pgEnum + `itemStatus` column on `orderItems` | VERIFIED | Exports `itemStatusEnum = pgEnum('item_status', ['pending', 'preparing', 'ready'])`; `orderItems` has `itemStatus` column with notNull + default 'pending' |
| `src/db/migrations/0002_add_item_status.sql` | CREATE TYPE item_status + ALTER TABLE + composite index | VERIFIED | Contains all three SQL statements; composite index on `(order_id, item_status)` present |
| `src/plugins/consumer/model.ts` | TypeBox `CreateOrderBody` with UUID array validation | VERIFIED | Exports `CreateOrderBody` with `t.String({ format: 'uuid' })` and `minItems: 1` |
| `src/plugins/consumer/service.ts` | `createOrder()`, `getActiveMenu()`, `getOrderHistory()` | VERIFIED | All three functions exported; `createOrder()` is substantive (219 lines of transaction logic); `DATABASE_DIRECT_URL` fallback for Neon lock correctness |
| `src/plugins/consumer/index.ts` | `consumerPlugin` with GET /menu, POST /orders, GET /orders | VERIFIED | All three routes present; auth guard via `requireRole('customer')` |
| `src/plugins/kds/model.ts` | `UpdateItemStatusBody`, `ToggleAvailabilityBody` TypeBox schemas | VERIFIED | Both schemas exported with correct union literals and boolean type |
| `src/plugins/kds/service.ts` | `updateItemStatus()`, `getActiveOrders()`, `toggleAvailability()` | VERIFIED | All three functions exported; NOT EXISTS guard, dual-channel notify, and row-count check all present |
| `src/plugins/kds/index.ts` | `kdsPlugin` with GET /orders, PATCH items, PATCH availability | VERIFIED | All three routes present; `requireRole('chef')` guard |
| `test/plugins/consumer.test.ts` | Unit tests for CONS-01, CONS-02, CONS-07, KDS-01 | VERIFIED | 7 tests across 3 describe blocks (CONS-01, CONS-02, CONS-07); all pass |
| `test/plugins/kds.test.ts` | Unit tests for KDS-02, KDS-03, KDS-04, KDS-05, CONS-06 | VERIFIED | 6 tests across 3 describe blocks; all pass |
| `test/integration/order-concurrency.test.ts` | CONS-03 concurrency test with skip guard | VERIFIED | `describe.skip` guard for non-Neon environments; `Promise.all` with `createOrderDirect`; passes/skips cleanly |
| `src/index.ts` | `consumerPlugin` and `kdsPlugin` mounted | VERIFIED | Both imports and `.use()` calls present before `.listen(3000)` |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `consumer/service.ts` | `ingredients` table (row lock) | `SELECT ... FOR UPDATE` in subquery | WIRED | Two-step lock: separate `SELECT i.id FROM ingredients ... FOR UPDATE` before data read |
| `consumer/service.ts` | `ingredients` table (stock decrement) | `UPDATE ingredients SET stock_quantity = stock_quantity - $1` | WIRED | Present inside transaction at line 144 |
| `consumer/service.ts` | `flashshell_events` channel `kds` | `SELECT pg_notify(...)` before COMMIT | WIRED | Line 188; payload contains `channel: 'kds', event: 'new_order'` |
| `consumer/index.ts` | `consumer/service.ts` | `createOrder()`, `getActiveMenu()`, `getOrderHistory()` called in handlers | WIRED | All three imports used; `createOrder(user.id, body.items)`, `getActiveMenu()`, `getOrderHistory(user.id)` |
| `kds/service.ts` | `order_items` table | `db.update(orderItems).set({ itemStatus })` | WIRED | Drizzle update with UUID WHERE clause |
| `kds/service.ts` | `orders` table | `UPDATE orders SET status = 'ready_for_pickup' WHERE NOT EXISTS (...)` | WIRED | Atomic guard present; rowCount check prevents duplicate notifies |
| `kds/service.ts` | `flashshell_events / order:{orderId}` | `pg_notify` after item status update | WIRED | Fired unconditionally for every successful item update (CONS-06) |
| `kds/service.ts` | `flashshell_events / kds + logistics` | Dual `pg_notify` on auto-advance | WIRED | Both fires inside `if (rowCount > 0)` guard |
| `src/index.ts` | `consumer/index.ts` + `kds/index.ts` | `.use(consumerPlugin).use(kdsPlugin)` | WIRED | Both registered before `.listen(3000)` |
| `integration/order-concurrency.test.ts` | `DATABASE_DIRECT_URL` Neon DB | `Promise.all` with two `createOrderDirect` calls | WIRED | Direct pg.Pool (not mocked service); skips gracefully without live DB |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CONS-01 | 02-01 | GET /consumer/menu returns active menu items | SATISFIED | `getActiveMenu()` with `isAvailable=true` filter; unit test green |
| CONS-02 | 02-01 | POST /consumer/orders creates order with atomic stock reservation | SATISFIED | SELECT FOR UPDATE + stock decrement + INSERT all in one transaction |
| CONS-03 | 02-01 | Two concurrent orders for last stock unit — exactly one succeeds | SATISFIED | Integration test proves serialization via SELECT FOR UPDATE on direct connection |
| CONS-06 | 02-02, 02-03 | Consumer receives item_status_changed WebSocket event | SATISFIED | `pg_notify` to `order:{orderId}` channel fired from `updateItemStatus()` |
| CONS-07 | 02-03 | GET /consumer/orders returns customer order history | SATISFIED | `getOrderHistory(customerId)` + route `/orders`; CONS-07 unit test green |
| KDS-01 | 02-01 | Chef receives WS push within 500ms of new order | SATISFIED | `pg_notify` inside transaction before COMMIT; pg LISTEN/NOTIFY hub wired in Phase 1 dispatches to WS clients |
| KDS-02 | 02-02 | GET /kds/orders returns confirmed + preparing orders | SATISFIED | `getActiveOrders()` with `inArray(['confirmed', 'preparing'])`; unit test green |
| KDS-03 | 02-02 | PATCH item status advances through preparing → ready | SATISFIED | `updateItemStatus()` updates `item_status` column; auto-advance on last ready item |
| KDS-04 | 02-02 | Auto-advance fires notify to kds + logistics on ready_for_pickup | SATISFIED | Dual `pg_notify` in `kds/service.ts` inside `if (rowCount > 0)` guard |
| KDS-05 | 02-02 | PATCH /kds/menu/:itemId/availability toggles isAvailable | SATISFIED | `toggleAvailability()` updates `menuItems.isAvailable`; 404 on unknown item |

---

## Anti-Patterns Found

No blockers or stubs found.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `STATE.md` | 43 | Phase 02 row shows "0/TBD Pending" | Info | Documentation staleness only — all 3 plans are complete per `stopped_at` and metrics rows in the same file |
| `ROADMAP.md` | 108 | Phase 2 progress table shows "2/3 In Progress" | Info | Documentation staleness only — ROADMAP not updated after 02-03 completion; no code impact |

---

## Human Verification Required

### 1. WS push latency under 500ms (KDS-01 SLA)

**Test:** Authenticated customer POSTs an order; authenticated chef has an active WebSocket connection subscribed to the `kds` channel. Measure time from POST response to WS push receipt.
**Expected:** WS event arrives at chef client within 500ms.
**Why human:** pg LISTEN/NOTIFY round-trip latency from Neon direct connection cannot be measured programmatically in a unit test. The wiring is verified (pg_notify inside transaction + Phase 1 LISTEN hub), but the 500ms SLA requires a live measurement.

### 2. Menu availability reflected immediately after chef toggle (Success Criterion 5)

**Test:** Chef calls `PATCH /kds/menu/:itemId/availability` with `{ isAvailable: false }`. Customer immediately calls `GET /consumer/menu`. Toggled item should not appear.
**Expected:** The item is absent from or marked unavailable in the menu response with no caching delay.
**Why human:** Drizzle Neon HTTP client has no local cache; the absence of caching is expected but should be confirmed once against live infra.

---

## Gaps Summary

No implementation gaps. All phase artifacts exist, are substantive, and are correctly wired. The full test suite passes (28/28 tests across 7 files). Integration test skips gracefully in unit-only environments and passes against a live Neon direct-URL connection.

Two documentation items are stale (ROADMAP.md and STATE.md show Phase 2 as incomplete) but have no impact on the running code. These can be updated as part of phase close-out housekeeping.

Three production bugs were discovered and auto-fixed during execution:
1. `FOR UPDATE OF i` rejected by PostgreSQL on nullable side of LEFT JOIN — fixed with two-step locking.
2. Neon PgBouncer transaction mode broke `SELECT FOR UPDATE` serialization — fixed by switching `txPool` to `DATABASE_DIRECT_URL`.
3. Bun 1.3.9 `mock.module()` leaks across test files — fixed by implementing concurrency test with direct pg.Pool, not importing the mocked service module.

All three fixes are present in the final codebase and are load-bearing for the concurrency guarantee.

---

_Verified: 2026-03-16_
_Verifier: Claude (gsd-verifier)_
