---
phase: 04-admin-and-control
plan: 02
subsystem: database
tags: [postgresql, triggers, pg_notify, drizzle, integration-tests, stock-management]

# Dependency graph
requires:
  - phase: 02-core-order-pipeline
    provides: orders table, order_items table, order_status enum
  - phase: 01-foundation
    provides: ingredients table, menu_item_ingredients table, LISTEN/NOTIFY listener.ts on flashshell_events channel
provides:
  - PostgreSQL trigger deduct_stock_on_confirm() on orders AFTER UPDATE
  - Automatic stock deduction when order transitions to confirmed
  - pg_notify order_confirmed to control channel on confirmation
  - pg_notify low_stock_alert to control channel when ingredient drops below critical_threshold
  - Migration 0004_stock_trigger.sql applied to database
affects: [04-admin-and-control, ws/listener.ts control channel consumers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PostgreSQL trigger function using AFTER UPDATE with OLD/NEW idempotency guard"
    - "pg_notify inside trigger via PERFORM (not SELECT) for void-returning calls"
    - "statement-breakpoint separators required between SQL statements for neon-http migrator"
    - "DELETE + INSERT idempotency pattern for tables without unique constraints in integration tests"

key-files:
  created:
    - src/db/migrations/0004_stock_trigger.sql
    - test/integration/stock-trigger.test.ts
  modified:
    - src/db/migrations/meta/_journal.json

key-decisions:
  - "statement-breakpoint separators required between SQL statements: neon-http migrator sends each statement as a prepared statement; multi-statement files fail with 'cannot insert multiple commands into a prepared statement'"
  - "journal 'when' timestamp must be greater than all prior entries or migration is silently skipped by Drizzle neon-http migrator"
  - "AFTER UPDATE (not BEFORE) trigger: side effects (stock write, pg_notify) only commit after the row update succeeds"
  - "OLD.status != 'confirmed' guard prevents double-deduction if a confirmed order receives subsequent updates"
  - "PERFORM pg_notify(...) not SELECT pg_notify(...): PL/pgSQL requires PERFORM for void-returning function calls"
  - "Low-stock alert uses FROM ingredients JOIN after stock update — reads post-deduction stock_quantity"

patterns-established:
  - "Trigger migration pattern: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER — each separated by '--> statement-breakpoint'"
  - "Integration test pg_notify verification: separate pg.Client for LISTEN, Promise with 5s timeout, resolve on matching event"

requirements-completed: [CTRL-01, CTRL-02]

# Metrics
duration: 5min
completed: 2026-03-18
---

# Phase 4 Plan 02: Stock Deduction Trigger Summary

**PostgreSQL trigger deduct_stock_on_confirm() deducts ingredient stock on order confirmation and emits pg_notify low_stock_alert + order_confirmed events to the control channel**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-18T09:25:00Z
- **Completed:** 2026-03-18T09:29:39Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created migration 0004_stock_trigger.sql with trigger function and applied it to live database
- Trigger deducts `stock_quantity -= (quantity_used * order_item_quantity)` for all ingredients in an order on confirmation
- Idempotent guard (`OLD.status != 'confirmed'`) prevents double-deduction on subsequent order updates
- pg_notify emits `order_confirmed` and `low_stock_alert` to `flashshell_events` channel → `control` sub-channel
- 4 integration tests pass against live Neon DB: stock deduction, idempotency, low-stock alert, order-confirmed event

## Task Commits

Each task was committed atomically:

1. **Task 1: Create stock deduction trigger migration** - `915b5ac` (feat)
2. **Task 1 fix: statement-breakpoint separators + journal timestamp** - `f0fa0e8` (fix)
3. **Task 2: Integration tests for stock trigger and low-stock alert** - `f8b82e8` (feat)

## Files Created/Modified
- `src/db/migrations/0004_stock_trigger.sql` - Trigger function deduct_stock_on_confirm() + trigger trg_deduct_stock_on_confirm
- `src/db/migrations/meta/_journal.json` - Added idx 4 entry with tag 0004_stock_trigger and correct timestamp
- `test/integration/stock-trigger.test.ts` - 4 integration tests for CTRL-01 and CTRL-02

## Decisions Made
- **statement-breakpoint separators are required**: neon-http Drizzle migrator sends each statement as a prepared statement. Multi-statement migration files fail with "cannot insert multiple commands into a prepared statement". Each SQL statement (CREATE FUNCTION, DROP TRIGGER, CREATE TRIGGER) needs `--> statement-breakpoint` between them.
- **Journal `when` timestamp must be chronologically after prior entries**: Drizzle neon-http migrator orders migrations by the `when` field. Using a stale timestamp (like `1710720000000` from 2024) silently skips the migration because it appears to predate applied migrations. Set to execution time `1773825900000`.
- **PERFORM for pg_notify in triggers**: PL/pgSQL requires PERFORM (not SELECT) for void-returning function calls. Using SELECT pg_notify() inside a trigger function would cause a syntax error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added statement-breakpoint separators to migration file**
- **Found during:** Task 1 verification (`bun run db:migrate`)
- **Issue:** Drizzle neon-http migrator cannot execute multiple SQL statements in one migration file — requires `--> statement-breakpoint` separators between each statement. The migration ran successfully once but the trigger/function were never created in the database.
- **Fix:** Added `--> statement-breakpoint` between CREATE FUNCTION, DROP TRIGGER IF EXISTS, and CREATE TRIGGER statements
- **Files modified:** src/db/migrations/0004_stock_trigger.sql
- **Verification:** `bun run db:migrate` exited 0; trigger and function confirmed in database via pg_proc and information_schema.triggers queries
- **Committed in:** f0fa0e8

**2. [Rule 1 - Bug] Corrected journal `when` timestamp for migration 0004**
- **Found during:** Task 1 verification (trigger not found in DB despite `db:migrate` success)
- **Issue:** Journal entry `when: 1710720000000` is earlier than all prior entries (0003 is `1773823109000`). The Drizzle neon-http migrator silently skipped migration 0004 because it appeared chronologically earlier than already-applied migrations.
- **Fix:** Changed `when` from `1710720000000` to `1773825900000` (current execution timestamp)
- **Files modified:** src/db/migrations/meta/_journal.json
- **Verification:** Migration applied; 5 entries in drizzle.__drizzle_migrations table
- **Committed in:** f0fa0e8

**3. [Rule 1 - Bug] Replaced ON CONFLICT DO NOTHING with DELETE + INSERT for order_items**
- **Found during:** Task 2 test execution
- **Issue:** `order_items` table has no unique constraint beyond PK — `ON CONFLICT DO NOTHING` requires a constraint. Error: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
- **Fix:** Changed to `DELETE FROM order_items WHERE order_id = $1` before INSERT
- **Files modified:** test/integration/stock-trigger.test.ts
- **Verification:** Tests ran without constraint error
- **Committed in:** f8b82e8

**4. [Rule 1 - Bug] Replaced ON CONFLICT on menu_item_ingredients with DELETE + INSERT**
- **Found during:** Task 2 test execution
- **Issue:** `menu_item_ingredients` table also has no unique constraint (no primary key defined in schema) — `ON CONFLICT (menu_item_id, ingredient_id)` failed with same constraint error
- **Fix:** Changed to `DELETE FROM menu_item_ingredients WHERE menu_item_id = $1 AND ingredient_id = $2` before INSERT
- **Files modified:** test/integration/stock-trigger.test.ts
- **Verification:** All 4 tests pass
- **Committed in:** f8b82e8

---

**Total deviations:** 4 auto-fixed (all Rule 1 bugs)
**Impact on plan:** All fixes were blockers discovered during verification. No scope creep. Plan artifacts delivered as specified.

## Issues Encountered
- Pre-existing auth.test.ts failure in full suite run (unrelated to this plan): `authPlugin — 401 on missing token` fails when run alongside other tests but passes in isolation. This is a pre-existing test isolation issue in the repo, out of scope for this plan.

## Next Phase Readiness
- Stock trigger live in database — CTRL-01 and CTRL-02 complete
- Control channel now receives `order_confirmed` and `low_stock_alert` events for admin dashboard (CTRL-03 real-time)
- Phase 04 plans can build on control channel events now emitted by the trigger

---
*Phase: 04-admin-and-control*
*Completed: 2026-03-18*
