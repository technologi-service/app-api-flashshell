---
phase: 03-logistics
plan: "02"
subsystem: couriers
tags: [gps-tracking, throttle, pg_notify, concurrency, integration-test]
dependency_graph:
  requires: ["03-01"]
  provides: [couriersPlugin, updateCourierLocation, logistics-concurrency-test]
  affects: [src/index.ts, test/integration/order-concurrency.test.ts]
tech_stack:
  added: []
  patterns: [upsert-on-conflict, pg-notify-broadcast, select-for-update-race, 30s-throttle]
key_files:
  created:
    - src/plugins/couriers/model.ts
    - src/plugins/couriers/service.ts
    - src/plugins/couriers/index.ts
    - test/plugins/couriers.test.ts
    - test/integration/logistics-concurrency.test.ts
  modified:
    - src/index.ts
    - test/integration/order-concurrency.test.ts
decisions:
  - "GPS upsert throttle uses updated_at timestamp check at service layer — simple and avoids Redis"
  - "Active-order check (picked_up query) doubles as both 403 auth guard and broadcast orderId resolver"
  - "Integration test uses gen_random_uuid() for orders.customer_id since orders.customer_id is uuid but courier user.id is text"
metrics:
  duration: "4 minutes"
  completed: "2026-03-18"
  tasks_completed: 2
  files_created: 5
  files_modified: 2
requirements_satisfied: [LOGI-02, LOGI-03, LOGI-04]
---

# Phase 03 Plan 02: Couriers Plugin + Concurrency Test Summary

**One-liner:** GPS ingestion POST /couriers/location with 30s throttle, pg_notify broadcast to order channel, and SELECT FOR UPDATE courier claim race condition test proving exactly-one-winner semantics.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Couriers plugin (GPS ingestion + unit tests) | e59e1ca | model.ts, service.ts, index.ts, couriers.test.ts |
| 2 | Wire plugins into index.ts + concurrency integration test | 59a344b | src/index.ts, logistics-concurrency.test.ts |

## What Was Built

### Couriers Plugin

**`src/plugins/couriers/model.ts`** — TypeBox schema `UpdateLocationBody` with lat (-90..90) and lng (-180..180) range constraints.

**`src/plugins/couriers/service.ts`** — `updateCourierLocation(courierId, lat, lng)` executes in 4 steps:
1. Find active `picked_up` order for the courier (authorization check + orderId resolution)
2. Throttle check: skip write silently if `updated_at < 30 seconds` ago
3. Upsert GPS coordinates via Drizzle `onConflictDoUpdate` targeting `courierLocations.courierId`
4. Broadcast via `pg_notify('flashshell_events', { channel: 'order:{orderId}', event: 'courier_location', ... })`

Returns `{ written: boolean; orderId: string | null }`. Null orderId signals 403 to the controller.

**`src/plugins/couriers/index.ts`** — `couriersPlugin` Elysia instance:
- `POST /couriers/location` with `requireRole('delivery')` guard
- Returns 403 when `orderId === null` (no active delivery)
- Returns `{ ok: true, written }` for both throttled (false) and written (true) cases

### src/index.ts Updates

Added imports and `.use()` calls for `logisticsPlugin` and `couriersPlugin`. Added OpenAPI tags for `logistics` and `couriers`. Replaced old Phase 3+ placeholder comment with `// Phase 4+ plugins registered here`.

### Concurrency Integration Test (LOGI-04)

`test/integration/logistics-concurrency.test.ts` proves that `SELECT ... FOR UPDATE` on `orders WHERE id = $1` serializes two simultaneous courier claims:
- Seeds one order in `ready_for_pickup` and two courier users
- Fires `Promise.all([claimOrderDirect(A), claimOrderDirect(B)])`
- Asserts exactly 1 success, 1 failure
- Asserts DB shows `status = 'picked_up'` with exactly one non-null `courier_id`
- Skipped automatically when no real DB (no placeholder URL check)

## Verification Results

```
bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts
→ 16 pass, 0 fail

bun test test/integration/logistics-concurrency.test.ts (real DB)
→ 1 pass, 0 fail

bun test (full suite)
→ 44 pass, 1 fail (auth.test.ts contamination — pre-existing, passes in isolation)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed order-concurrency.test.ts INSERT missing delivery_address**
- **Found during:** Task 2 verification (full `bun test` run)
- **Issue:** Migration 0003_add_courier_columns (from plan 03-01) added `delivery_address TEXT NOT NULL` to orders, but `test/integration/order-concurrency.test.ts` INSERT statement didn't include this column. Caused NOT NULL constraint violation on the real DB.
- **Fix:** Added `delivery_address` column with empty string default to the INSERT statement in `createOrderDirect()`
- **Files modified:** test/integration/order-concurrency.test.ts
- **Commit:** 012e116

**2. [Rule 1 - Bug] Fixed logistics-concurrency.test.ts customer_id type mismatch**
- **Found during:** Task 2 verification (first integration test run)
- **Issue:** Orders schema has `customer_id UUID NOT NULL`, but test was trying to use `courierAId` (text) as `customer_id`. Caused UUID parse error.
- **Fix:** Used `gen_random_uuid()` for `orders.customer_id` in the seed INSERT — couriers and customer are distinct roles; no need to reuse the courier user as customer.
- **Files modified:** test/integration/logistics-concurrency.test.ts
- **Commit:** 59a344b (fixed inline before committing)

### Out-of-Scope Items (Deferred)

- `auth.test.ts` intermittent failure in full suite (Bun 1.3.9 shared module registry contamination from mock.module() calls in other test files). Pre-existing issue, passes in isolation. Not introduced by this plan.

## Decisions Made

1. GPS throttle check at service layer using `updated_at` column — no Redis required, consistent with no-Redis-in-v1 constraint.
2. Active-order check doubles as both authorization signal (return `orderId: null` → controller returns 403) and broadcast channel resolver (extract `orderId` for `pg_notify` channel key).
3. Integration test uses `gen_random_uuid()` for `orders.customer_id` — avoids the type mismatch between orders's UUID FK and Better Auth's text user IDs.

## Self-Check: PASSED
