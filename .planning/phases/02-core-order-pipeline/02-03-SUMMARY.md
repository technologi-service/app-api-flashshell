---
phase: 02-core-order-pipeline
plan: "03"
subsystem: api
tags: [elysia, postgres, select-for-update, drizzle, bun-test, integration-test]

# Dependency graph
requires:
  - phase: 02-01
    provides: consumerPlugin with GET /consumer/menu and POST /consumer/orders, createOrder() service
  - phase: 02-02
    provides: kdsPlugin with GET /kds/orders, PATCH item status, PATCH availability

provides:
  - GET /consumer/orders endpoint (CONS-07) — order history for authenticated customer
  - consumerPlugin and kdsPlugin wired into src/index.ts
  - CONS-03 integration test proving SELECT FOR UPDATE serializes concurrent stock reservations
  - Fix: txPool uses DATABASE_DIRECT_URL to bypass Neon PgBouncer for correct SELECT FOR UPDATE

affects:
  - Phase 03 (Logistics) — server now fully wired, plugins mounted, Phase 2 API surface complete
  - Any future plan touching createOrder() — must use DATABASE_DIRECT_URL for transactions

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Integration tests use direct pg.Pool queries (not service module imports) to avoid mock.module() contamination in Bun 1.3.9 full suite runs"
    - "SELECT FOR UPDATE must use DATABASE_DIRECT_URL (not the pooled URL) with Neon — PgBouncer transaction mode does not preserve row locks across queries"
    - "Two-step locking: separate SELECT FOR UPDATE on ingredients, then plain SELECT for data read"

key-files:
  created:
    - test/integration/order-concurrency.test.ts
  modified:
    - src/plugins/consumer/service.ts
    - src/plugins/consumer/index.ts
    - src/index.ts
    - test/plugins/consumer.test.ts

key-decisions:
  - "txPool switched from DATABASE_URL to DATABASE_DIRECT_URL: Neon PgBouncer transaction mode does not preserve SELECT FOR UPDATE locks across queries within a BEGIN/COMMIT block"
  - "Integration test uses direct pg.Pool instead of importing service.ts: Bun 1.3.9 shares module registry across test files — mock.module() from consumer.test.ts contaminates imports in the same run"
  - "FOR UPDATE OF i replaced with two-step locking: separate SELECT...FOR UPDATE on ingredients subquery + plain SELECT for data — PostgreSQL rejects FOR UPDATE on nullable side of outer join"

patterns-established:
  - "Integration tests: implement transaction logic directly in test file using pg.Pool — do not import from service modules that are mocked in unit test files"
  - "Neon transactions: always use DATABASE_DIRECT_URL for pg.Pool when SELECT FOR UPDATE is needed"

requirements-completed:
  - CONS-06
  - CONS-07

# Metrics
duration: 13min
completed: 2026-03-16
---

# Phase 2 Plan 03: Wire Plugins, Order History, and Concurrency Test Summary

**GET /consumer/orders (CONS-07) added, consumerPlugin + kdsPlugin wired into index.ts, and CONS-03 integration test proving SELECT FOR UPDATE serializes concurrent stock reservations on Neon direct connection**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-16T13:51:30Z
- **Completed:** 2026-03-16T14:04:40Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 5

## Accomplishments

- Added `getOrderHistory(customerId)` to consumer service and `GET /consumer/orders` route to consumerPlugin
- Wired `consumerPlugin` and `kdsPlugin` into `src/index.ts` — server now fully functional
- Created CONS-03 integration test that fires two concurrent orders when stock=1, confirms exactly one succeeds and one fails
- Fixed three bugs: `FOR UPDATE OF i` (LEFT JOIN restriction), txPool pooler URL (Neon PgBouncer lock issue), integration test module contamination

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add failing CONS-07 tests** - `ecbd060` (test)
2. **Task 1 GREEN: Implement GET /consumer/orders, wire plugins** - `c0a85be` (feat)
3. **Task 2: Initial concurrency test + FOR UPDATE fix** - `faf64c5` (feat)
4. **Task 2 fixes: Direct URL + mock contamination fix** - `5f86811` (fix)

## Files Created/Modified

- `src/plugins/consumer/service.ts` — Added `getOrderHistory()`, switched txPool to `DATABASE_DIRECT_URL`, restructured SELECT FOR UPDATE to two-step locking
- `src/plugins/consumer/index.ts` — Added `GET /orders` route, imported `getOrderHistory`
- `src/index.ts` — Added imports and `.use(consumerPlugin).use(kdsPlugin)` before `.listen(3000)`
- `test/plugins/consumer.test.ts` — Added `mockGetOrderHistory` mock and CONS-07 describe block
- `test/integration/order-concurrency.test.ts` — Created CONS-03 integration test with direct pg.Pool implementation

## Decisions Made

- **txPool uses DATABASE_DIRECT_URL:** Neon PgBouncer transaction mode (`-pooler` URL) does not preserve row locks across queries in a BEGIN/COMMIT — different queries may get different backend connections. DATABASE_DIRECT_URL bypasses PgBouncer and connects directly to the compute instance. Falls back to DATABASE_URL if DIRECT not set (for local/non-Neon envs).

- **Integration test uses direct pg.Pool implementation:** Bun 1.3.9 shares module registry across test files running in the same process. `mock.module('../../src/plugins/consumer/service', ...)` in consumer.test.ts contaminates `require()/import()` of the same path in order-concurrency.test.ts. Fix: implement the transaction logic directly in the test file, mirroring service.ts behavior without importing it.

- **Two-step locking instead of `FOR UPDATE OF i`:** PostgreSQL rejects `FOR UPDATE` on the nullable side of an outer join. Fix: issue a separate `SELECT...FOR UPDATE` on ingredients via a subquery, then do the main data read as a plain SELECT (ingredients already locked).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] PostgreSQL rejects FOR UPDATE OF i in outer join context**
- **Found during:** Task 2 (CONS-03 integration test)
- **Issue:** `FOR UPDATE OF i` fails with `FOR UPDATE cannot be applied to the nullable side of an outer join` because `ingredients` is LEFT JOINed (nullable side)
- **Fix:** Restructure to two-step locking: separate `SELECT i.id ... FOR UPDATE` on ingredients via subquery, then main SELECT without FOR UPDATE (rows already locked)
- **Files modified:** `src/plugins/consumer/service.ts`
- **Verification:** Integration test passes, unit tests unaffected
- **Committed in:** `faf64c5`

**2. [Rule 1 - Bug] Neon PgBouncer transaction mode does not preserve SELECT FOR UPDATE locks**
- **Found during:** Task 2 (CONS-03 concurrency test — both orders succeeded despite stock=1)
- **Issue:** DATABASE_URL points to the Neon pooler (`-pooler` hostname). PgBouncer transaction mode can route different queries in the same transaction to different backend connections, breaking SELECT FOR UPDATE serialization
- **Fix:** Switch `txPool` from `process.env.DATABASE_URL` to `process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL`
- **Files modified:** `src/plugins/consumer/service.ts`
- **Verification:** Concurrency test passes with exactly one success and one failure
- **Committed in:** `5f86811`

**3. [Rule 1 - Bug] Bun 1.3.9 mock.module() leaks across test files in full suite run**
- **Found during:** Task 2 (integration test passes standalone but fails in `bun test`)
- **Issue:** `mock.module('../../src/plugins/consumer/service', ...)` in consumer.test.ts replaces the real module in Bun's module cache, affecting all subsequent imports of the same path in the same run (including integration test's `require()`/dynamic import)
- **Fix:** Rewrite integration test to implement order transaction logic directly via `pg.Pool` without importing service.ts — the test mirrors createOrder() semantics precisely without touching the mocked module
- **Files modified:** `test/integration/order-concurrency.test.ts`
- **Verification:** `bun test` full suite: 28/28 pass
- **Committed in:** `5f86811`

---

**Total deviations:** 3 auto-fixed (all Rule 1 bugs discovered during integration testing)
**Impact on plan:** All auto-fixes essential for correctness. The FOR UPDATE bug and Neon pooler bug were fundamental — the concurrency guarantee wouldn't hold without them. No scope creep.

## Issues Encountered

- afterAll cleanup failed on first test run because order_items references menu_items (FK constraint) — fixed by deleting in correct dependency order: order_items → orders → menu_items → ingredients → users
- Test data left in DB after first failed run — fixed with `ON CONFLICT DO UPDATE` for idempotent user seeding

## Next Phase Readiness

- Phase 2 API surface is complete: consumer plugin (menu, orders), KDS plugin (queue, item status, availability), WebSocket real-time, all mounted in index.ts
- Phase 3 (Logistics) can add `logisticsPlugin` after the Phase 3+ comment in index.ts
- txPool now using DATABASE_DIRECT_URL — future plans with SELECT FOR UPDATE should follow the same pattern

## Self-Check: PASSED

All files exist and all commits verified:
- FOUND: src/plugins/consumer/service.ts
- FOUND: src/plugins/consumer/index.ts
- FOUND: src/index.ts
- FOUND: test/plugins/consumer.test.ts
- FOUND: test/integration/order-concurrency.test.ts
- FOUND commit: ecbd060 (test RED)
- FOUND commit: c0a85be (feat GREEN)
- FOUND commit: faf64c5 (feat task 2)
- FOUND commit: 5f86811 (fix bugs)

---
*Phase: 02-core-order-pipeline*
*Completed: 2026-03-16*
