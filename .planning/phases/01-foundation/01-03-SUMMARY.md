---
phase: 01-foundation
plan: 03
subsystem: infra
tags: [elysia, websocket, pg, listen-notify, health-check, bun, neon]

# Dependency graph
requires:
  - phase: 01-01
    provides: Drizzle db client (db.execute) for health probe
  - phase: 01-02
    provides: auth.api.getSession for WS auth gate, authPlugin for index.ts mount

provides:
  - GET /health endpoint — unprotected, returns db status + process uptime
  - pg LISTEN hub — persistent pg.Client on DATABASE_DIRECT_URL with exponential backoff reconnect
  - wsPlugin — WebSocket at /ws/:channel with Bearer auth gate via beforeHandle
  - Final src/index.ts with all three Phase 1 plugins mounted in correct order

affects: [02-consumer, 03-kds, 04-logistics]

# Tech tracking
tech-stack:
  added: []  # pg was already in package.json; no new dependencies added
  patterns:
    - "Health probe with timeout race — db.execute wrapped in Promise.race with 3s timeout ensures graceful degraded response in test/offline environments"
    - "pg.Client for LISTEN — raw pg.Client on DATABASE_DIRECT_URL (never pooled) is the correct pattern for Neon LISTEN/NOTIFY"
    - "Exponential backoff reconnect — Math.min(delayMs * 2, 30_000) pattern for supervised pg reconnect"
    - "WS auth gate — auth.api.getSession({ headers }) in beforeHandle returns status(401) before WS upgrade if no session"
    - "In-memory channel registry — Map<string, Set<ws>> populated by registerSocket/unregisterSocket for fan-out dispatch"

key-files:
  created:
    - src/plugins/health/index.ts
    - src/plugins/ws/listener.ts
    - src/plugins/ws/index.ts
    - test/plugins/health.test.ts
    - test/plugins/ws.test.ts
  modified:
    - src/index.ts

key-decisions:
  - "3-second DB probe timeout added to healthPlugin — prevents health check from hanging when DATABASE_URL is unreachable (test env or degraded Neon)"
  - "onError registered before .use() calls in index.ts — Elysia applies lifecycle hooks to routes registered AFTER them; this ordering ensures all plugin routes get global error handling"
  - "listener.ts exports registerSocket/unregisterSocket — wsPlugin uses these to manage per-channel socket sets; dispatch() fan-out is decoupled from WS lifecycle"
  - "startListener() called at module load time in ws/index.ts — hub starts automatically when wsPlugin is imported by index.ts"

patterns-established:
  - "Plugin prefix pattern: every plugin is new Elysia({ name, prefix }) registered via .use()"
  - "Health probe timeout: always race DB calls with a timeout Promise in health checks"
  - "WS channel registry: Map<channelName, Set<ws>> pattern for fan-out, populated via register/unregister exports"

requirements-completed: [INFRA-05]

# Metrics
duration: 4min
completed: 2026-03-15
---

# Phase 1 Plan 3: Health Check, WebSocket Hub, and Final index.ts Summary

**pg LISTEN/NOTIFY hub on DATABASE_DIRECT_URL with exponential backoff, GET /health with Neon probe, and /ws/:channel with Bearer auth gate — all three plugins mounted in final index.ts**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-15T20:32:41Z
- **Completed:** 2026-03-15T20:35:49Z
- **Tasks:** 2 of 3 automated tasks completed (task 3 is checkpoint:human-verify — awaiting)
- **Files modified:** 6

## Accomplishments

- GET /health returns `{ status: 'ok'|'degraded', db: 'ok'|'degraded', uptime: number }` without requiring Authorization header
- pg LISTEN hub uses `pg.Client` on `DATABASE_DIRECT_URL` (never pooled) — reconnects with exponential backoff (1s → 2s → 4s → max 30s) on error
- wsPlugin at `/ws/:channel` verifies Bearer token via `auth.api.getSession({ headers })` in `beforeHandle` before WebSocket upgrade
- Final `src/index.ts` mounts authPlugin, healthPlugin, wsPlugin with `onError` registered before all `.use()` calls
- Full test suite: 14 tests across 4 files, all green

## Task Commits

Each task was committed atomically:

1. **Task 1: Health plugin and WebSocket hub (TDD)** - `6f68d95` (feat)
2. **Task 2: Wire healthPlugin and wsPlugin into final index.ts** - `fe47f22` (feat)

## Files Created/Modified

- `src/plugins/health/index.ts` — GET /health unprotected endpoint, Neon probe with 3s timeout, returns status + db + uptime
- `src/plugins/ws/listener.ts` — pg.Client LISTEN hub on DATABASE_DIRECT_URL, exponential backoff reconnect, dispatch/register/unregister exports
- `src/plugins/ws/index.ts` — Elysia wsPlugin at /ws/:channel, beforeHandle auth gate, calls startListener() on load
- `src/index.ts` — Final root app: onError first, then authPlugin + healthPlugin + wsPlugin
- `test/plugins/health.test.ts` — 4 tests: 200 status, status field, db field, uptime as number
- `test/plugins/ws.test.ts` — 2 tests: startListener/dispatch exports, dispatch to unknown channel

## Decisions Made

- **3-second DB probe timeout:** `db.execute('SELECT 1')` is wrapped in `Promise.race` with a 3s timeout. The `@neondatabase/serverless` HTTP client does not fail fast against the placeholder URL in test environments — without the timeout all 4 health tests would hang until Bun's 5s test timeout. The timeout ensures tests always complete and health always returns `degraded` gracefully.
- **onError before .use():** The original `src/index.ts` (from plan 01-02) had `.use(authPlugin)` before `.onError()`. Elysia applies lifecycle hooks only to routes registered after them — so I fixed the order to: `.onError()` → `.use(authPlugin)` → `.use(healthPlugin)` → `.use(wsPlugin)`.
- **Open question 2 resolved (partial):** The WS `beforeHandle` returns `status(401, {...})` when no session is present. Confirmed via WebSocket skill reference that `beforeHandle` returning non-2xx status aborts the WS upgrade. Full HTTP-level verification requires a running server (covered in human checkpoint).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added 3-second timeout to healthPlugin DB probe**
- **Found during:** Task 1 (TDD GREEN phase for healthPlugin)
- **Issue:** `db.execute('SELECT 1')` against the placeholder Neon URL in test environment does not throw — it hangs indefinitely. The first two health tests timed out at Bun's 5s limit.
- **Fix:** Wrapped `db.execute` in `Promise.race` with a 3-second reject timeout. Health probe returns `'degraded'` on any error including timeout.
- **Files modified:** `src/plugins/health/index.ts`
- **Verification:** All 4 health tests pass after fix (db shows 'degraded' in test env — valid per spec)
- **Committed in:** `6f68d95` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed onError registration order in index.ts**
- **Found during:** Task 2 (wiring index.ts)
- **Issue:** Prior plan (01-02) left `.use(authPlugin)` before `.onError()` — Elysia only applies lifecycle hooks to routes registered AFTER them, so errors in authPlugin routes would not be caught by the global handler.
- **Fix:** Reordered to `.onError()` first, then all `.use()` calls. This matches the plan's required final state.
- **Files modified:** `src/index.ts`
- **Verification:** grep confirms onError appears before first .use() in file
- **Committed in:** `fe47f22` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs)
**Impact on plan:** Both fixes necessary for correctness. DB probe timeout is required for test suite to function. onError ordering is required for correct error handling in production.

## Issues Encountered

- `@neondatabase/serverless` HTTP client hangs instead of rejecting against placeholder URLs — requires explicit timeout guard in all DB probes used in tests.

## User Setup Required

The LISTEN/NOTIFY hub requires:
- `DATABASE_DIRECT_URL` — Neon Dashboard → Project → Connection Details → **Direct** connection string (not pooled)
- `DATABASE_URL` — Neon Dashboard → Project → Connection Details → **Pooled** connection string

Without `DATABASE_DIRECT_URL`, the hub logs a warning and disables itself gracefully. The health check will show `db: 'degraded'` if `DATABASE_URL` is not set.

## Verification Status

### Automated (confirmed green)

- `bun test` — 14 tests, 0 fail across 4 files
- `grep "DATABASE_DIRECT_URL" src/plugins/ws/listener.ts` — passes
- `grep "startListener()" src/plugins/ws/index.ts` — passes
- `grep "SELECT 1" src/plugins/health/index.ts` — passes

### Manual (pending human checkpoint)

- GET /health returns `{"status":"ok","db":"ok","uptime":N}` with live Neon (HTTP 200)
- GET /ws/test without auth → HTTP 401 before WS upgrade
- pg_notify('flashshell_events', '{"channel":"kds","event":"test","data":{}}') → server logs within 1s
- POST /auth/sign-up/email creates user with role="customer"

## Next Phase Readiness

- Phase 2 (Consumer plugin) can begin once human checkpoint is approved
- Remaining blocker from STATE.md: Elysia 1.4.27 ws() pub/sub API specifics need verification — PARTIALLY resolved: beforeHandle auth gate approach confirmed working per skill reference; full live WS test in checkpoint will close this blocker

---
*Phase: 01-foundation*
*Completed: 2026-03-15*
