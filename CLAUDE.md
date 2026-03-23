## Project

FlashShell Engine — Dark Kitchen order pipeline API. Processes orders from customer placement through kitchen preparation to courier delivery, with real-time WebSocket updates and Stripe payments.

**Runtime:** Bun 1.3.10+ | **Framework:** Elysia | **DB:** PostgreSQL (Neon) | **ORM:** Drizzle

## Architecture

### Plugin Pattern (Critical)

Every domain module is an Elysia plugin: `new Elysia({ name, prefix })`. The main `src/index.ts` only mounts plugins — no routes or business logic there.

Each plugin follows a 3-file structure:
- `index.ts` — Elysia plugin with routes, uses `authPlugin` + `requireRole()`
- `service.ts` — DB queries and business logic
- `model.ts` — TypeBox schemas for request/response validation

**When creating new plugins, always use this pattern:**
```typescript
new Elysia({ name: 'plugin-name', prefix: '/route-prefix' })
  .use(authPlugin)
  .use(requireRole('role'))
  .get('/path', handler, { auth: true, ...schema })
```

### Auth Macro Propagation

The auth plugin uses a macro with `{ as: 'scoped' }` — this is what makes `{ auth: true }` available in child plugins. The macro resolves the session from Bearer token or cookie header and sets `user` + `session` on context. Without `{ as: 'scoped' }`, auth won't propagate to plugins that `.use(authPlugin)`.

`requireRole()` uses `onBeforeHandle` (not `derive`) because only `onBeforeHandle` can short-circuit requests. Returning from `derive()` does nothing.

### Two Database Connections

- **`DATABASE_URL`** (pooled/PgBouncer) — used by the app for normal queries via `@neondatabase/serverless` neon() + drizzle
- **`DATABASE_DIRECT_URL`** (direct) — required for: migrations, `LISTEN/NOTIFY` (WebSocket listener), and transactions (Stripe webhook handler)

Never use the pooled URL for migrations or LISTEN/NOTIFY — Neon's pooler blocks prepared statements and persistent connections.

### WebSocket Hub

`src/plugins/ws/` — Elysia WebSocket at `/ws/:channel` with pre-upgrade Bearer auth in `beforeHandle`. Channels: `order:{orderId}`, `kds`, `logistics`, `control`. Backend broadcasts via PostgreSQL `LISTEN/NOTIFY` on `flashshell_events` channel — services call `pg_notify()` after state changes.

### Stripe Payment Flow

Consumer creates order → POST `/consumer/orders/:id/pay` returns `clientSecret` → frontend confirms with Stripe.js → Stripe fires webhook to POST `/webhooks/stripe` → transactional handler: check idempotency → insert payment_intent → update order status to `confirmed` → `pg_notify` to WebSocket channels. The webhook endpoint has no auth (Stripe calls it directly with signature verification).

### Role System

Four roles: `customer`, `chef`, `delivery`, `admin`. Role is set to `customer` at signup with `input: false` — users cannot choose their role. Role changes only via direct DB update (seed scripts). Each plugin enforces its role via `requireRole()`.

| Plugin | Prefix | Role |
|--------|--------|------|
| consumer | `/consumer` | customer |
| kds | `/kds` | chef |
| logistics | `/logistics` | delivery |
| couriers | `/couriers` | delivery |
| control | `/control` | admin |
| payments | `/webhooks/stripe` | none (Stripe webhook) |
| health | `/health` | none |

### Schema Location

Database schema is split across `src/db/schema/`: `auth.ts`, `orders.ts`, `menu.ts`, `logistics.ts`, `payments.ts`. Enums for order status (`pending|confirmed|preparing|ready_for_pickup|picked_up|delivered|cancelled`) and item status (`pending|preparing|ready`) are defined in `orders.ts`.

## Dev Environment

Swagger UI at `http://localhost:3001/swagger` (dev only). After running `bun run db:seed:roles`, use these test accounts:

| Role | Email | Password |
|------|-------|----------|
| customer | customer@test.com | password123 |
| chef | chef@flashshell.test | test-chef-pass |
| delivery | delivery@flashshell.test | test-delivery-pass |
| admin | admin@flashshell.test | test-admin-pass |

## Error Response Convention

All errors follow `{ error: 'ERROR_CODE', message: string }`. Status codes: 401 UNAUTHORIZED, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT (stock/state), 422 VALIDATION_ERROR (with `details` array).
