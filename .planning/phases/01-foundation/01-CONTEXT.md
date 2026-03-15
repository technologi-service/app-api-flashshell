# Phase 1: Foundation - Context

**Gathered:** 2026-03-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Lay the technical bedrock: Neon database schema + versioned migrations, Better Auth with role-based middleware, and the WebSocket hub with Neon LISTEN/NOTIFY. Everything Phase 2–5 builds on top of this without retrofitting.

Out of scope for this phase: no business routes, no order logic, no KDS, no payments. Only the infrastructure contracts every other phase depends on.

</domain>

<decisions>
## Implementation Decisions

### Database Schema Scope
- Define **all tables for all 5 phases now** in Phase 1 — INFRA-01 says "esquema completo" and the success criteria requires "all database tables exist in Neon"
- Drizzle ORM schema in `src/db/schema/` with one file per domain area (users, menu, orders, logistics, control)
- All migrations versioned in `src/db/migrations/`, idempotent via `bun run db:migrate`
- Include `tenant_id` column as nullable/defaulted on every business table — not enforced in v1 but schema-ready for future multi-tenancy

**Tables to define in this phase:**
- `users`, `sessions`, `accounts` — managed by Better Auth (schema auto-generated or adapted)
- `menu_items` — id, name, description, price, is_available, tenant_id
- `ingredients` — id, name, unit, stock_quantity, critical_threshold, cost_per_unit, tenant_id
- `menu_item_ingredients` — junction: menu_item_id, ingredient_id, quantity_used
- `orders` — id, customer_id, status (enum), total_amount, tenant_id, created_at
- `order_items` — order_id, menu_item_id, quantity, unit_price
- `courier_locations` — courier_id, lat, lng, updated_at (upsert by courier_id, max 1 row per courier)
- `payment_intents` — order_id, stripe_payment_intent_id, status, idempotency_key

**Order status enum:** `pending → confirmed → preparing → ready_for_pickup → picked_up → delivered | cancelled`

### Auth Behavior
- Email + password only for v1 (no social login providers)
- Roles: `customer | chef | delivery | admin` — stored in Better Auth user record and surfaced in session token
- Admin accounts: **not via public signup** — seeded via a `bun run db:seed:admin` script using env vars (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`)
- Session expiry: Better Auth defaults — 7-day rolling sessions, access token refreshed automatically
- Multi-device: allowed — no single-session constraint in v1
- Better Auth mounted at `/auth/**` prefix; Elysia plugin wraps it via `betterAuth.handler`

### Middleware Design
- `authMiddleware` Elysia plugin: reads Bearer token from `Authorization` header, verifies with Better Auth session, attaches `{ userId, role }` to context
- Role guard: `requireRole(...roles)` Elysia plugin factory — applied per-route or per-plugin. Returns 403 with descriptive body if role doesn't match
- Applied via Elysia `.use()` — never inline in `index.ts`
- `/health` endpoint is **unprotected** (explicitly no auth)

### WebSocket Channel Topology
- **Hybrid model**: per-order channels + per-role broadcast channels
  - `order:{orderId}` — consumer subscribes to track their own order status (confirmed → preparing → ready → delivered)
  - `kds` — chef role broadcast: receives new order events
  - `logistics` — delivery role broadcast: receives ready-for-pickup events
  - `control` — admin broadcast: receives all order state changes + stock alerts
- **Connection authentication**: HTTP Bearer token verified in Elysia `beforeHandle` on the WebSocket route before upgrade. Unauthenticated upgrade attempts receive 401 before WS handshake completes
- **LISTEN/NOTIFY mapping**: the hub holds a single `DATABASE_DIRECT_URL` pg connection and issues `LISTEN flashshell_events`. Application code calls `pg_notify('flashshell_events', payload::json)` — the hub receives it and fans out to the correct WS channel based on `payload.channel`
- Supervised reconnection: if the LISTEN connection drops, exponential backoff reconnect (1s → 2s → 4s → max 30s), logs each attempt

### Error Response Contract
Consistent JSON shape across all endpoints:

```
{ "error": "ERROR_CODE", "message": "Human-readable description", "details"?: [...] }
```

- `401 UNAUTHORIZED` — missing or invalid token
- `403 FORBIDDEN` — valid token but insufficient role; include `"required": ["chef"]` in body
- `422 VALIDATION_ERROR` — TypeBox schema failure; `"details"` array contains field-level errors from Elysia's built-in validation
- `404 NOT_FOUND` — resource doesn't exist
- `409 CONFLICT` — stock race condition or duplicate resource
- `500 INTERNAL_ERROR` — unexpected; never expose stack traces in response body

All error responses use the same top-level shape — clients parse by `error` code, not HTTP status alone.

### Project Structure
```
src/
  index.ts              — mount plugins only, no business logic
  db/
    schema/             — one file per domain (menu.ts, orders.ts, etc.)
    migrations/         — Drizzle generated migration files
    client.ts           — Drizzle client export (pooled URL)
  plugins/
    auth/               — Better Auth setup + Elysia authMiddleware + requireRole
    ws/                 — WebSocket hub plugin (LISTEN/NOTIFY + channel fan-out)
    health/             — GET /health plugin
```

Each plugin: `new Elysia({ prefix: '/...' })` exported and registered with `.use()` in `index.ts`.

### Claude's Discretion
- Exact Drizzle column types and index definitions (infer from use case)
- Better Auth adapter configuration details (Drizzle adapter setup)
- Exact reconnect backoff algorithm implementation
- TypeBox schema file organization within each plugin
- Seed script implementation details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — INFRA-01 through INFRA-05: exact acceptance criteria for this phase
- `.planning/ROADMAP.md` Phase 1 success criteria (lines 26-31) — the 5 testable conditions that define done

### Project context
- `.planning/PROJECT.md` — Stack constraints (Bun + Elysia + TypeScript, no Redis), plugin pattern mandate, Better Auth + Neon decisions

No external ADRs or design specs — requirements are fully captured in decisions above and in REQUIREMENTS.md.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/index.ts`: bare Elysia bootstrap (`new Elysia().get("/", ...).listen(3000)`) — the entry point to extend
- `package.json`: only `elysia` + `bun-types` installed — all dependencies (Drizzle, Better Auth, pg) need to be added in this phase

### Established Patterns
- Elysia plugin pattern is **mandated**: every module is `new Elysia({ prefix })` registered via `.use()` — never inline domain code in `index.ts`
- No existing patterns for auth, DB, or WebSocket — Phase 1 establishes all of them

### Integration Points
- `src/index.ts` is where all plugins are mounted — Phase 2+ plugins will `.use()` from here
- Drizzle client in `src/db/client.ts` becomes the shared DB singleton imported by all phases
- WebSocket hub in `src/plugins/ws/` becomes the notification emitter called by all domain plugins

</code_context>

<specifics>
## Specific Ideas

- `/health` endpoint must return Neon connectivity status (attempt a `SELECT 1` and report OK/DEGRADED) and server uptime — explicitly required by success criteria
- The WebSocket hub MUST use `DATABASE_DIRECT_URL` (not the pooled URL) for LISTEN/NOTIFY — pooled connections cannot hold long-lived LISTEN state
- `bun run db:migrate` must be idempotent — running twice should be a no-op, not an error

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-15*
