---
phase: 02-core-order-pipeline
plan: "01"
subsystem: api
tags: [elysia, drizzle, postgresql, pg-notify, select-for-update, drizzle-migration, typebox]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: authPlugin macro, requireRole factory, db Drizzle client, wsPlugin pg_notify listener, schema menu.ts
provides:
  - itemStatusEnum pgEnum and itemStatus column on order_items (migration 0002_add_item_status.sql)
  - consumerPlugin Elysia plugin at /consumer with GET /menu and POST /orders
  - createOrder() transaction with SELECT FOR UPDATE, stock decrement, pg_notify to kds channel
  - getActiveMenu() via Drizzle ORM filtered to isAvailable=true
  - Unit tests for CONS-01, CONS-02, KDS-01 with mocked DB
affects:
  - 02-core-order-pipeline (kds plugin reads orders placed here)
  - 03-logistics (delivery assignments triggered by confirmed orders)

# Tech tracking
tech-stack:
  added: [pg (Pool for transactional SELECT FOR UPDATE)]
  patterns:
    - pg.Pool on DATABASE_URL for transaction-mode queries (BEGIN/COMMIT with FOR UPDATE)
    - Drizzle ORM db client for simple selects (getActiveMenu)
    - pg_notify inside transaction before COMMIT for atomic broadcast
    - mock.module() with valid UUID fixtures for Elysia unit tests

key-files:
  created:
    - src/plugins/consumer/index.ts
    - src/plugins/consumer/service.ts
    - src/plugins/consumer/model.ts
    - src/db/migrations/0002_add_item_status.sql
    - test/plugins/consumer.test.ts
  modified:
    - src/db/schema/orders.ts
    - src/db/migrations/meta/_journal.json

key-decisions:
  - "pg.Pool (max:5) on DATABASE_URL for SELECT FOR UPDATE transactions — Neon PgBouncer transaction mode preserves BEGIN/COMMIT within a single connection"
  - "FOR UPDATE OF i targets only ingredients rows, not menu_items — allows concurrent reads of menu while serializing stock mutations"
  - "pg_notify fires inside transaction before COMMIT so KDS notification and order confirmation are atomic"
  - "Test fixtures must use valid UUID strings — TypeBox format: 'uuid' validation rejects non-UUID values like 'item-1'"

patterns-established:
  - "Transaction pattern: pg.Pool.connect() + BEGIN + SELECT FOR UPDATE + UPDATE + INSERT + pg_notify + COMMIT (ROLLBACK in catch)"
  - "Failure collection: gather ALL failing item IDs before rejecting — return 409 with full failures[] array"
  - "Mock pattern for auth-protected Elysia plugins: mock.module() for service + authPlugin + requireRole, then dynamic import"

requirements-completed: [CONS-01, CONS-02, CONS-03, KDS-01]

# Metrics
duration: 4min
completed: 2026-03-16
---

# Phase 2 Plan 01: Consumer Plugin and item_status Migration Summary

**consumerPlugin Elysia plugin with atomic order creation via SELECT FOR UPDATE, stock decrement, and pg_notify to kds channel — backed by migration 0002_add_item_status.sql adding itemStatusEnum to order_items**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-16T09:34:36Z
- **Completed:** 2026-03-16T09:38:11Z
- **Tasks:** 3 completed
- **Files modified:** 8

## Accomplishments

- Migration 0002_add_item_status.sql applied — order_items now has item_status column with enum values pending/preparing/ready and composite index on (order_id, item_status)
- consumerPlugin mounted at /consumer with GET /menu (Drizzle ORM) and POST /orders (pg.Pool transaction) behind customer auth guard
- createOrder() implements full write path: SELECT FOR UPDATE on ingredients, stock decrement UPDATE, INSERT order + order_items, pg_notify to kds — all atomic within one transaction
- Unit test scaffold green (4/4 tests) with mocked service and auth

## Task Commits

Each task was committed atomically:

1. **Task 1: Add item_status migration and extend orders schema** - `58ee6cd` (feat)
2. **Task 2: Implement consumerPlugin** - `645f2ba` (feat)
3. **Task 3: Write consumer unit test scaffold** - `cc22e74` (test)

## Files Created/Modified

- `src/db/schema/orders.ts` - Added itemStatusEnum pgEnum + itemStatus column to orderItems table
- `src/db/migrations/0002_add_item_status.sql` - CREATE TYPE item_status + ALTER TABLE + composite index
- `src/db/migrations/meta/_journal.json` - Updated with 0002_add_item_status entry
- `src/plugins/consumer/model.ts` - CreateOrderBody TypeBox schema with UUID array validation
- `src/plugins/consumer/service.ts` - createOrder() transaction + getActiveMenu() Drizzle select
- `src/plugins/consumer/index.ts` - consumerPlugin Elysia plugin at /consumer prefix
- `test/plugins/consumer.test.ts` - Unit tests for CONS-01, CONS-02, KDS-01

## Decisions Made

- **pg.Pool for transactions:** Drizzle's HTTP Neon client (`db`) cannot hold a connection open for SELECT FOR UPDATE. Using pg.Pool on DATABASE_URL with max:5 connections handles this within Neon's PgBouncer transaction mode.
- **FOR UPDATE OF i only:** Lock targets only `ingredients` rows (aliased `i`), not `menu_items`. This allows concurrent browsing of the menu while serializing stock mutations.
- **pg_notify inside transaction:** The notify call is placed before COMMIT so that if COMMIT fails the KDS is never notified of a non-existent order — atomic by design.
- **Migration file rename:** drizzle-kit generated `0002_burly_squirrel_girl.sql`; file was renamed to `0002_add_item_status.sql` per plan spec with journal tag updated accordingly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixtures used non-UUID strings rejected by TypeBox format validation**
- **Found during:** Task 3 (consumer unit tests)
- **Issue:** Plan template used `'item-1'`, `'order-1'` etc. as fixture IDs; TypeBox `t.String({ format: 'uuid' })` validation returns 422 for non-UUID values — tests for 200 and 409 were getting 422
- **Fix:** Replaced all fixture IDs with valid UUIDs (`'11111111-1111-1111-1111-111111111111'` etc.)
- **Files modified:** `test/plugins/consumer.test.ts`
- **Verification:** `bun test test/plugins/consumer.test.ts` — 4/4 pass
- **Committed in:** cc22e74 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in plan template)
**Impact on plan:** Auto-fix necessary for test correctness. No scope creep.

## Issues Encountered

- drizzle-kit generates random migration file names (`0002_burly_squirrel_girl.sql`) — renamed to `0002_add_item_status.sql` and updated `_journal.json` tag accordingly. Migration applied successfully after rename.

## User Setup Required

None — no external service configuration required beyond the Neon DATABASE_URL already provisioned in Phase 1.

## Next Phase Readiness

- Consumer write path complete: orders are created, stock decremented, KDS notified
- `consumerPlugin` ready to be registered in `src/index.ts` (not done in this plan per spec)
- Phase 2 Plan 02 (KDS plugin) can consume pg_notify events from flashshell_events channel
- No blockers

---
*Phase: 02-core-order-pipeline*
*Completed: 2026-03-16*

## Self-Check: PASSED

- FOUND: src/db/schema/orders.ts
- FOUND: src/db/migrations/0002_add_item_status.sql
- FOUND: src/plugins/consumer/index.ts
- FOUND: src/plugins/consumer/service.ts
- FOUND: src/plugins/consumer/model.ts
- FOUND: test/plugins/consumer.test.ts
- FOUND commit: 58ee6cd (task 1)
- FOUND commit: 645f2ba (task 2)
- FOUND commit: cc22e74 (task 3)
