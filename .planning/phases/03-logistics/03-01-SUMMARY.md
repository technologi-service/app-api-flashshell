---
phase: 03-logistics
plan: "01"
subsystem: logistics
tags: [courier, delivery, state-machine, pg_notify, migration, select-for-update]
dependency_graph:
  requires:
    - "02-03: consumer order creation (orders table with stock deduction)"
    - "01-02: requireRole plugin and authPlugin"
    - "01-03: pg_notify flashshell_events channel"
  provides:
    - "Courier pickup list endpoint (GET /logistics/orders/ready)"
    - "Order detail endpoint for couriers (GET /logistics/orders/:id)"
    - "Delivery state machine (PATCH /logistics/orders/:id/status)"
    - "Migration 0003 adding courier_id and delivery_address to orders"
  affects:
    - "03-02: real-time logistics notifications rely on order channel events"
    - "Consumer orders now require deliveryAddress field"
tech_stack:
  added:
    - "logistics Elysia plugin (src/plugins/logistics/)"
  patterns:
    - "SELECT FOR UPDATE via pg.Pool on DATABASE_DIRECT_URL (same as consumer/service.ts)"
    - "pg_notify inside transaction for atomic state transitions"
    - "Partial index on (status, courier_id) for efficient pickup queries"
    - "Text FK for courier_id matching user.id text PK"
key_files:
  created:
    - src/db/migrations/0003_add_courier_columns.sql
    - src/plugins/logistics/model.ts
    - src/plugins/logistics/service.ts
    - src/plugins/logistics/index.ts
    - test/plugins/logistics.test.ts
  modified:
    - src/db/migrations/meta/_journal.json
    - src/db/schema/orders.ts
    - src/plugins/consumer/model.ts
    - src/plugins/consumer/service.ts
    - src/plugins/consumer/index.ts
    - test/plugins/consumer.test.ts
decisions:
  - "courier_id is text (not uuid) in migration and schema to match user.id text PK — no Drizzle .references() call to avoid type mismatch error"
  - "Partial index WHERE status IN ('preparing','ready_for_pickup') AND courier_id IS NULL for O(log n) pickup list queries"
  - "advanceOrderStatus uses txPool (DATABASE_DIRECT_URL) for SELECT FOR UPDATE to avoid PgBouncer connection reuse"
  - "getOrderDetail access control: order is visible if it is unclaimed or belongs to this courier OR is still in open status"
metrics:
  duration: "~4 minutes"
  completed: "2026-03-18"
  tasks: 2
  files: 11
---

# Phase 3 Plan 1: Logistics Plugin and Migration Summary

**One-liner:** Courier-facing order management via pg-pool SELECT FOR UPDATE state machine with atomic pg_notify to order and control channels.

## Tasks Completed

| # | Task | Commit | Key Files |
|---|------|--------|-----------|
| 1 | Migration, schema update, consumer extension | b11c01d | 0003_add_courier_columns.sql, orders.ts, consumer/model.ts, consumer/service.ts |
| 2 | Logistics plugin + unit tests | 32fe1c1 | logistics/index.ts, logistics/service.ts, logistics/model.ts, logistics.test.ts |

## What Was Built

### Migration (0003_add_courier_columns.sql)
- Added `courier_id text` (nullable FK to `user.id`) and `delivery_address text NOT NULL` to orders table
- FK constraint `orders_courier_id_user_fk` with ON DELETE SET NULL
- Partial index `idx_orders_pickup_list` on `(status, courier_id)` WHERE status IN open pickup states and courier_id IS NULL

### Drizzle Schema Update (orders.ts)
- Added `courierId: text('courier_id')` and `deliveryAddress: text('delivery_address').notNull()` columns
- No `.references()` call (FK is in migration SQL only — avoids Drizzle type mismatch between uuid() and text)

### Consumer Extension
- `CreateOrderBody` now requires `deliveryAddress: t.String({ minLength: 1 })`
- `createOrder` service accepts `deliveryAddress: string` as third parameter
- INSERT INTO orders now persists `delivery_address`
- `CreatedOrder` interface includes `deliveryAddress` in return type

### Logistics Plugin
- `GET /logistics/orders/ready` — pickup list of unclaimed preparing/ready_for_pickup orders with items
- `GET /logistics/orders/:id` — full order detail with access control
- `PATCH /logistics/orders/:id/status` — atomic state machine: `picked_up` and `delivered` transitions
- Role guard: `requireRole('delivery')` applied to all routes

### Service Functions
- `getPickupList()` — raw SQL join via Drizzle HTTP client, aggregates rows by order ID in JS
- `getOrderDetail(orderId, courierId)` — join query with access control logic
- `advanceOrderStatus(orderId, courierId, newStatus)` — transactional with SELECT FOR UPDATE:
  - `picked_up`: validates ready_for_pickup status, null courier_id, one-active-order constraint
  - `delivered`: validates picked_up status and courier ownership
  - pg_notify to `order:{orderId}` and `control` channels inside transaction

### Unit Tests (11 tests, all pass)
Covers LOGI-01 and LOGI-04:
- GET /orders/ready: pickup list shape verification
- GET /orders/:id: 200 success, 404 not found, 403 forbidden
- PATCH /orders/:id/status: 200 picked_up, 200 delivered, 409 already_claimed, 409 courier_busy, 409 invalid_transition, 404 not found, 422 invalid body

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] consumer.test.ts mock type mismatch after deliveryAddress added**
- **Found during:** Task 1 (TypeScript check after updating CreatedOrder interface)
- **Issue:** Bun mock inferred narrow return type from initial value; `mockImplementationOnce` returning `{ ok: false }` branch was not assignable
- **Fix:** Explicitly typed `mockCreateOrder` mock with full union return type; added `deliveryAddress` to mock return value; updated request bodies in test to include required `deliveryAddress` field
- **Files modified:** test/plugins/consumer.test.ts
- **Commit:** b11c01d (included in Task 1 commit)

## Self-Check: PASSED
