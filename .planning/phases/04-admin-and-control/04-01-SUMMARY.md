---
phase: 04-admin-and-control
plan: "01"
subsystem: api
tags: [admin, control, cashflow, orders, drizzle, elysia, typebox, tdd]

# Dependency graph
requires:
  - "02-01: orders and order_items schema (id, status, total_amount, delivery_address)"
  - "02-02: kdsPlugin with order state transitions"
  - "01-02: requireRole plugin and authPlugin with admin role"
  - "03-01: logistics plugin with courier_id and delivery_address columns on orders"
provides:
  - "GET /control/orders/active — admin dashboard with live orders NOT IN (delivered, cancelled)"
  - "GET /control/reports/cashflow?from=&to= — revenue and stock cost aggregation for date range"
  - "controlPlugin Elysia instance with admin-only role guard"
affects:
  - "04-02: stock trigger and any future admin dashboard features"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "controlPlugin follows same structure as logisticsPlugin: prefix + authPlugin + requireRole guard"
    - "COALESCE(SUM(...), 0)::text pattern for nullable aggregates returning strings"
    - "Map-based row aggregation for grouped SQL results (same as logistics/service.ts)"

key-files:
  created:
    - src/plugins/control/model.ts
    - src/plugins/control/service.ts
    - src/plugins/control/index.ts
    - test/plugins/control.test.ts
  modified:
    - src/index.ts

key-decisions:
  - "cashflow query filters WHERE o.status = 'confirmed' — only confirmed orders count as revenue (not pending/preparing)"
  - "createdAt in ActiveOrderResult serialized as ISO string (not Date) to ensure consistent JSON serialization"
  - "getCashflowReport joins menu_item_ingredients and ingredients to compute stock cost per order item"

patterns-established:
  - "Admin read-only endpoints use GET only — no mutations in control plugin"
  - "COALESCE(SUM(value), 0)::text pattern avoids null in aggregate results"

requirements-completed: [CTRL-03, CTRL-04]

# Metrics
duration: 5min
completed: "2026-03-18"
---

# Phase 4 Plan 1: Flash-Control Admin Plugin Summary

**Admin plugin exposing two read-only endpoints: live active-order dashboard (NOT IN delivered/cancelled) and cash-flow report (revenue + stock cost via COALESCE SUM) with admin-role guard via requireRole.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-18T09:17:42Z
- **Completed:** 2026-03-18T09:22:26Z
- **Tasks:** 2 (TDD: RED → GREEN → Task 2)
- **Files modified:** 5

## Accomplishments

- controlPlugin with `/control` prefix, admin-only guard, two read-only endpoints
- `getActiveOrders()` queries orders NOT IN ('delivered', 'cancelled') with items via Map aggregation
- `getCashflowReport(from, to)` aggregates `COALESCE(SUM(total_amount), 0)` and `COALESCE(SUM(qty * quantity_used * cost_per_unit), 0)` for 'confirmed' orders in date range
- 7 unit tests passing (TDD: failing RED, then GREEN implementation)
- controlPlugin wired into `src/index.ts` after couriersPlugin

## Task Commits

Each task was committed atomically:

1. **TDD RED: Failing tests for CTRL-03 and CTRL-04** - `6af0fb5` (test)
2. **TDD GREEN: controlPlugin model, service, routes** - `8c226c3` (feat)
3. **Task 2: Wire controlPlugin into index.ts** - `be583f3` (feat)

## Files Created/Modified

- `src/plugins/control/model.ts` — CashflowQuery, CashflowResponse, ActiveOrder TypeBox schemas
- `src/plugins/control/service.ts` — getActiveOrders() and getCashflowReport() with raw SQL via db.execute
- `src/plugins/control/index.ts` — controlPlugin with /control prefix, .use(requireRole('admin')), two GET routes
- `test/plugins/control.test.ts` — 7 unit tests with mocked service, authPlugin, requireRole
- `src/index.ts` — added controlPlugin import, .use(controlPlugin), OpenAPI 'control' tag

## Decisions Made

- `cashflow WHERE o.status = 'confirmed'`: only confirmed orders represent actual revenue; pending/preparing orders have not yet been accepted into the kitchen pipeline
- `createdAt` serialized as ISO string in service layer to avoid JSON Date serialization inconsistency across environments
- Stock cost formula: `SUM(oi.quantity * mii.quantity_used * i.cost_per_unit)` — per order item, calculates ingredient cost based on menu item recipe

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing test failure in `auth.test.ts` (1 of 52 tests) due to Bun 1.3.9 mock.module() contamination from couriers.test.ts — this regression pre-dates Phase 4 (present since Phase 3 commit e59e1ca). No new failures introduced by this plan. Logged to deferred-items per scope boundary rules.

## Next Phase Readiness

- controlPlugin is live at /control; admin role guard confirmed via requireRole('admin')
- Ready for Plan 04-02: stock trigger (critical stock threshold alerts for admin)
- No external service configuration required

---
*Phase: 04-admin-and-control*
*Completed: 2026-03-18*
