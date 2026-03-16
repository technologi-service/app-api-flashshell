---
phase: 02-core-order-pipeline
plan: "02"
subsystem: api
tags: [elysia, drizzle, postgresql, pg_notify, kds, websocket, real-time]

# Dependency graph
requires:
  - phase: 02-01
    provides: consumer plugin, item_status enum on order_items, pg_notify pattern established
  - phase: 01-foundation
    provides: authPlugin, requireRole, db client, ws listener dispatch()
provides:
  - kdsPlugin Elysia plugin at /kds with GET /orders, PATCH /orders/:id/items/:itemId, PATCH /menu/:itemId/availability
  - getActiveOrders(): returns confirmed+preparing orders with their items
  - updateItemStatus(): updates item_status, fires pg_notify to consumer order channel and auto-advances order
  - toggleAvailability(): updates is_available on menu_items
  - Atomic NOT EXISTS guard preventing race condition on auto-advance to ready_for_pickup
affects:
  - logistics (03): receives pg_notify on 'logistics' channel when order reaches ready_for_pickup
  - consumer (already built): receives pg_notify on 'order:{orderId}' channel for item_status_changed events

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD: write failing test file (RED), commit, write implementation (GREEN), verify all pass"
    - "Atomic auto-advance: UPDATE orders WHERE NOT EXISTS (non-ready items) — prevents duplicate notify on concurrent requests"
    - "Dual-channel pg_notify: fire both kds and logistics channels when order reaches ready_for_pickup"
    - "Consumer notify: pg_notify on order:{orderId} for item-level status changes (CONS-06)"

key-files:
  created:
    - src/plugins/kds/model.ts
    - src/plugins/kds/service.ts
    - src/plugins/kds/index.ts
    - test/plugins/kds.test.ts
  modified: []

key-decisions:
  - "neon-http db.execute result shape: check both .rows?.length and Array.isArray(result) for advance rowCount — handles Drizzle neon-http vs pg driver differences"
  - "Auto-advance only fires logistics/kds notifies when UPDATE actually changed rows — checked via rowCount > 0"
  - "Elysia plugin pattern: new Elysia({ name: 'kds', prefix: '/kds' }) with .use(authPlugin).use(requireRole('chef'))"

patterns-established:
  - "KDS auto-advance: UPDATE orders SET status=ready_for_pickup WHERE NOT EXISTS (non-ready items) — atomic guard"
  - "pg_notify after item update: always fire order:{orderId} channel regardless of advance; fire kds+logistics channels only on advance"

requirements-completed: [KDS-02, KDS-03, KDS-04, KDS-05, CONS-06]

# Metrics
duration: 15min
completed: 2026-03-16
---

# Phase 2 Plan 02: KDS Plugin Summary

**kdsPlugin with atomic NOT EXISTS auto-advance, dual-channel pg_notify (kds+logistics), and consumer item-status WebSocket events via Drizzle neon-http**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-16T10:50:00Z
- **Completed:** 2026-03-16T11:05:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- kdsPlugin fully wired at /kds: chef-only routes guarded by requireRole('chef')
- updateItemStatus with atomic NOT EXISTS guard prevents race condition on concurrent last-item-ready requests
- pg_notify fires to three channels: order:{orderId} (consumer), kds (chef), logistics (courier) — only kds+logistics on auto-advance
- toggleAvailability updates menu item isAvailable flag, returns 404 for unknown items
- 7 unit tests covering all success/failure/edge cases, full suite 25/25 green

## Task Commits

Each task was committed atomically:

1. **Task 1: kdsPlugin service (RED — service + model files)** - `381b5b4` (feat)
2. **Task 2 RED: failing tests for KDS routes** - `cfbe95d` (test)
3. **Task 2 GREEN: kdsPlugin routes implementation** - `5779594` (feat)

_Note: TDD tasks have separate RED (test) and GREEN (feat) commits_

## Files Created/Modified
- `src/plugins/kds/model.ts` - TypeBox schemas: UpdateItemStatusBody, ToggleAvailabilityBody
- `src/plugins/kds/service.ts` - getActiveOrders, updateItemStatus (with NOT EXISTS guard + pg_notify), toggleAvailability
- `src/plugins/kds/index.ts` - kdsPlugin Elysia plugin, chef-role guard, 3 routes
- `test/plugins/kds.test.ts` - 7 unit tests with mocked service and auth, covers KDS-02, KDS-03, KDS-04, KDS-05, CONS-06

## Decisions Made
- neon-http `db.execute()` returns results differently from raw pg — used `(result as any).rows?.length ?? (Array.isArray(result) ? result.length : 0)` to safely check if UPDATE advanced the order
- Auto-advance only fires logistics/kds notify when rowCount > 0 — prevents spurious notifications when another concurrent request already advanced the order
- kdsPlugin uses `new Elysia({ name: 'kds', prefix: '/kds' })` following the established Elysia plugin pattern for all pilars

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. The service files (service.ts, model.ts) were found pre-written in the kds/ directory from the prior commit context. Verified done criteria before committing, then proceeded to TDD for kdsPlugin routes.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- kdsPlugin complete and tested; ready to be registered in main app index
- logistics channel consumer (Phase 03) can now receive ready_for_pickup events via pg_notify
- All KDS requirements (KDS-02, KDS-03, KDS-04, KDS-05) and CONS-06 fulfilled

---
*Phase: 02-core-order-pipeline*
*Completed: 2026-03-16*
