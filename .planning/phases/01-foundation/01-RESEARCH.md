# Phase 1: Foundation - Research

**Researched:** 2026-03-15
**Domain:** Drizzle ORM + Neon PostgreSQL, Better Auth with roles, Elysia plugin architecture, WebSocket hub with LISTEN/NOTIFY
**Confidence:** HIGH (all core findings verified against official docs, skill files, and authoritative sources)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Database Schema Scope**
- Define all tables for all 5 phases now in Phase 1 — INFRA-01 says "esquema completo" and the success criteria requires "all database tables exist in Neon"
- Drizzle ORM schema in `src/db/schema/` with one file per domain area (users, menu, orders, logistics, control)
- All migrations versioned in `src/db/migrations/`, idempotent via `bun run db:migrate`
- Include `tenant_id` column as nullable/defaulted on every business table — not enforced in v1 but schema-ready for future multi-tenancy

Tables to define in this phase:
- `users`, `sessions`, `accounts` — managed by Better Auth (schema auto-generated or adapted)
- `menu_items` — id, name, description, price, is_available, tenant_id
- `ingredients` — id, name, unit, stock_quantity, critical_threshold, cost_per_unit, tenant_id
- `menu_item_ingredients` — junction: menu_item_id, ingredient_id, quantity_used
- `orders` — id, customer_id, status (enum), total_amount, tenant_id, created_at
- `order_items` — order_id, menu_item_id, quantity, unit_price
- `courier_locations` — courier_id, lat, lng, updated_at (upsert by courier_id, max 1 row per courier)
- `payment_intents` — order_id, stripe_payment_intent_id, status, idempotency_key

Order status enum: `pending → confirmed → preparing → ready_for_pickup → picked_up → delivered | cancelled`

**Auth Behavior**
- Email + password only for v1 (no social login providers)
- Roles: `customer | chef | delivery | admin` — stored in Better Auth user record and surfaced in session token
- Admin accounts: not via public signup — seeded via `bun run db:seed:admin` using env vars (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`)
- Session expiry: Better Auth defaults — 7-day rolling sessions, access token refreshed automatically
- Multi-device: allowed — no single-session constraint in v1
- Better Auth mounted at `/auth/**` prefix; Elysia plugin wraps it via `betterAuth.handler`

**Middleware Design**
- `authMiddleware` Elysia plugin: reads Bearer token from `Authorization` header, verifies with Better Auth session, attaches `{ userId, role }` to context
- Role guard: `requireRole(...roles)` Elysia plugin factory — applied per-route or per-plugin. Returns 403 with descriptive body if role doesn't match
- Applied via Elysia `.use()` — never inline in `index.ts`
- `/health` endpoint is unprotected (explicitly no auth)

**WebSocket Channel Topology**
- Hybrid model: per-order channels + per-role broadcast channels
  - `order:{orderId}` — consumer subscribes to track their own order status
  - `kds` — chef role broadcast: receives new order events
  - `logistics` — delivery role broadcast: receives ready-for-pickup events
  - `control` — admin broadcast: receives all order state changes + stock alerts
- Connection authentication: HTTP Bearer token verified in Elysia `beforeHandle` on the WebSocket route before upgrade. Unauthenticated upgrade attempts receive 401 before WS handshake completes
- LISTEN/NOTIFY mapping: the hub holds a single `DATABASE_DIRECT_URL` pg connection and issues `LISTEN flashshell_events`. Application code calls `pg_notify('flashshell_events', payload::json)` — the hub receives it and fans out to the correct WS channel based on `payload.channel`
- Supervised reconnection: if the LISTEN connection drops, exponential backoff reconnect (1s → 2s → 4s → max 30s), logs each attempt

**Error Response Contract**
Consistent JSON shape across all endpoints:
```
{ "error": "ERROR_CODE", "message": "Human-readable description", "details"?: [...] }
```
- `401 UNAUTHORIZED` — missing or invalid token
- `403 FORBIDDEN` — valid token but insufficient role; include `"required": ["chef"]` in body
- `422 VALIDATION_ERROR` — TypeBox schema failure; `"details"` array contains field-level errors
- `404 NOT_FOUND` — resource doesn't exist
- `409 CONFLICT` — stock race condition or duplicate resource
- `500 INTERNAL_ERROR` — unexpected; never expose stack traces in response body

**Project Structure**
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

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | El sistema provee un esquema de base de datos completo con migraciones versionadas (Drizzle ORM + Neon) | Drizzle Kit generate + migrate flow; `__drizzle_migrations` table tracks applied migrations for idempotence |
| INFRA-02 | Todos los endpoints validan el cuerpo de la petición contra schemas TypeBox y retornan errores descriptivos | Elysia built-in TypeBox validation + `onError` global handler; `drizzle-typebox` for schema reuse |
| INFRA-03 | El sistema autentica usuarios con Better Auth y expone roles: `customer | chef | delivery | admin` | Better Auth `additionalFields` user.role with `input: false`; Drizzle adapter generates tables |
| INFRA-04 | Un middleware central rechaza peticiones sin token válido o con rol insuficiente en todos los endpoints protegidos | Elysia macro pattern (`betterAuth` named plugin with `resolve`) + `requireRole` factory using `.as('scoped')` |
| INFRA-05 | El servidor mantiene una conexión WebSocket hub usando Neon `DATABASE_DIRECT_URL` con LISTEN/NOTIFY y reconexión supervisada automática ante caídas | Raw `pg.Client` (not pooled) on `DATABASE_DIRECT_URL`; Elysia `.ws()` with in-memory connection maps; custom exponential backoff reconnect |
</phase_requirements>

---

## Summary

Phase 1 establishes the three foundational pillars of the FlashShell Engine: the complete Drizzle ORM schema with versioned migrations on Neon, Better Auth with role-based middleware as Elysia plugins, and the WebSocket hub driven by Neon's LISTEN/NOTIFY mechanism.

The stack is well-verified and documented in the project's own ElysiaJS skill. Elysia 1.4.27 is already installed. Drizzle ORM with `@neondatabase/serverless` is the standard Neon integration path for Bun; for migrations specifically a direct (non-pooled) `DATABASE_DIRECT_URL` is required — the same constraint that applies to the LISTEN/NOTIFY hub. Better Auth stores the role as a string field in the `user` table using `additionalFields`; the Drizzle adapter auto-generates the auth tables.

The one subtlety in this phase is the WebSocket hub's LISTEN/NOTIFY connection: it must use `pg.Client` (raw, non-pooled) directly — NOT `@neondatabase/serverless` which is HTTP-based and cannot hold persistent LISTEN state. The `pg` npm package (v8.x) works in Bun due to Node.js compatibility. A custom supervised reconnect with exponential backoff must be hand-implemented since `pg-listen` (last release 2020) has unclear Bun compatibility and is effectively unmaintained.

**Primary recommendation:** Use `@neondatabase/serverless` for the Drizzle pooled client (`DATABASE_URL`), and a separate raw `pg.Client` bound to `DATABASE_DIRECT_URL` for the LISTEN/NOTIFY hub. This is the only configuration that satisfies both serverless query performance and persistent LISTEN state.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `elysia` | 1.4.27 (installed) | HTTP + WebSocket server framework | Already installed; Bun-native, TypeBox-integrated |
| `drizzle-orm` | latest stable (^0.40) | TypeScript ORM — schema, queries, migrations | Official Neon + Bun guide recommends it; type-safe schema |
| `drizzle-kit` | latest stable | Migration generation and apply CLI | Companion to drizzle-orm; generates SQL from TS schema |
| `@neondatabase/serverless` | latest | Neon WebSocket-based pooled driver | Required for Neon serverless; supports interactive transactions |
| `pg` | ^8.x | Raw PostgreSQL client for LISTEN/NOTIFY | Only non-pooled client that can hold LISTEN state in Bun |
| `better-auth` | latest | Auth framework — email+password, sessions, roles | TypeScript-first, framework-agnostic, Drizzle adapter included |
| `@types/pg` | ^8.x (dev) | TypeScript types for pg | Required since pg ships with JS, not TS types |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `drizzle-typebox` | latest | Convert Drizzle schema → TypeBox for Elysia validation | Use in Phase 2+ for request/response validation reuse |
| `dotenv` | (Bun built-in) | Env var loading | Bun loads `.env` natively; no explicit dotenv needed in Bun scripts |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@neondatabase/serverless` | `postgres` (Postgres.js) | Postgres.js is faster for Node but less idiomatic with Neon; Neon serverless is official |
| raw `pg.Client` for LISTEN | `pg-listen` | pg-listen has automatic reconnect but hasn't been maintained since 2020, unclear Bun compat; custom logic is ~30 lines and fully controllable |
| Better Auth `additionalFields` | Separate roles table | Separate table is overkill for fixed 4-role system; BA stores as comma-separated string, sufficient for v1 |

**Installation:**
```bash
bun add drizzle-orm @neondatabase/serverless pg better-auth
bun add -D drizzle-kit @types/pg
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── index.ts                  # mount plugins only: .use(healthPlugin).use(authPlugin).use(wsPlugin)
├── db/
│   ├── schema/
│   │   ├── auth.ts           # users, sessions, accounts, verification (Better Auth managed)
│   │   ├── menu.ts           # menu_items, ingredients, menu_item_ingredients
│   │   ├── orders.ts         # orders, order_items, order_status enum
│   │   ├── logistics.ts      # courier_locations
│   │   └── payments.ts       # payment_intents
│   ├── migrations/           # drizzle-kit generated SQL files
│   ├── client.ts             # drizzle() export using @neondatabase/serverless (pooled)
│   └── migrate.ts            # standalone migration runner script
├── plugins/
│   ├── auth/
│   │   ├── index.ts          # Elysia plugin: mounts Better Auth handler + macro
│   │   └── require-role.ts   # requireRole(...roles) plugin factory
│   ├── ws/
│   │   ├── index.ts          # Elysia plugin: .ws('/ws', ...) + pg LISTEN/NOTIFY hub
│   │   └── listener.ts       # pg.Client LISTEN with supervised reconnect
│   └── health/
│       └── index.ts          # Elysia plugin: GET /health (unprotected)
scripts/
└── seed-admin.ts             # bun run db:seed:admin
drizzle.config.ts             # drizzle-kit config
```

### Pattern 1: Elysia Plugin as Autonomous Module

**What:** Each infrastructure concern is a `new Elysia({ name: 'plugin-name' })` that encapsulates its own routes, decorators, and hooks. Registered in `index.ts` via `.use()`.

**When to use:** Always — this is the mandated pattern. The `name` field enables Elysia's deduplication so if a plugin is `.use()`'d from multiple places it only initializes once.

**Example:**
```typescript
// src/plugins/health/index.ts
// Source: project CONTEXT.md + elysiajs skill plugin.md
import { Elysia } from 'elysia'
import { db } from '../../db/client'

export const healthPlugin = new Elysia({ name: 'health', prefix: '/health' })
  .get('/', async () => {
    let dbStatus: 'ok' | 'degraded' = 'ok'
    try {
      await db.execute('SELECT 1')
    } catch {
      dbStatus = 'degraded'
    }
    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      db: dbStatus,
      uptime: process.uptime()
    }
  })
```

### Pattern 2: Better Auth Macro for Session Resolution

**What:** A named Elysia plugin exposes a `.macro()` that performs session verification once per request and attaches `{ userId, role }` to context. Routes opt in by declaring `{ auth: true }` in their route config.

**When to use:** All protected routes. The macro's `resolve` runs in the same lifecycle position as `beforeHandle` but with full type inference.

**Example:**
```typescript
// src/plugins/auth/index.ts
// Source: elysiajs skill integrations/better-auth.md
import { Elysia } from 'elysia'
import { auth } from './better-auth'

export const authPlugin = new Elysia({ name: 'better-auth' })
  .mount('/auth', auth.handler)
  .macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers })
        if (!session) return status(401)
        return {
          user: session.user,
          session: session.session
        }
      }
    }
  })
```

### Pattern 3: requireRole Plugin Factory

**What:** A function that returns an Elysia plugin scoped to `scoped` — meaning it applies to the parent plugin that `.use()`'s it. Checks `user.role` from the already-resolved session context.

**When to use:** Per-plugin or per-route role enforcement. Applied after `authPlugin` is `.use()`'d.

**Example:**
```typescript
// src/plugins/auth/require-role.ts
// Source: elysiajs skill references/plugin.md (scope casting + .as('scoped'))
import { Elysia } from 'elysia'

export const requireRole = (...roles: string[]) =>
  new Elysia({ name: `require-role-${roles.join('-')}` })
    .derive({ as: 'scoped' }, ({ user, status }) => {
      if (!user) return status(401)
      if (!roles.includes(user.role)) {
        return status(403, {
          error: 'FORBIDDEN',
          message: `Requires role: ${roles.join(' or ')}`,
          required: roles
        })
      }
    })
```

### Pattern 4: LISTEN/NOTIFY Hub with Supervised Reconnect

**What:** A standalone module (not an Elysia plugin itself) that owns a `pg.Client` connection to `DATABASE_DIRECT_URL`. On receiving a notification, it parses the JSON payload and dispatches to in-memory WS connection sets keyed by channel name. The Elysia WebSocket plugin imports this hub and registers connections on open/close.

**When to use:** Only one LISTEN hub exists in the process. It is started once at server boot. It is NOT the pooled Drizzle client.

**Example:**
```typescript
// src/plugins/ws/listener.ts
// Source: node-postgres docs + project CONTEXT.md design
import { Client } from 'pg'

const CHANNEL = 'flashshell_events'
let client: Client

function createClient() {
  return new Client({ connectionString: process.env.DATABASE_DIRECT_URL })
}

async function connect() {
  client = createClient()
  await client.connect()
  await client.query(`LISTEN ${CHANNEL}`)
  client.on('notification', (msg) => {
    if (!msg.payload) return
    const payload = JSON.parse(msg.payload)
    dispatch(payload.channel, payload)
  })
  client.on('error', (err) => {
    console.error('[ws-listener] pg error:', err.message)
    reconnect(1000)
  })
}

function reconnect(delay: number) {
  setTimeout(async () => {
    try {
      await connect()
    } catch {
      reconnect(Math.min(delay * 2, 30_000))
    }
  }, delay)
}

export function startListener() {
  connect().catch(() => reconnect(1000))
}
```

### Pattern 5: Drizzle Schema with Neon + Migration Script

**What:** Schema in `src/db/schema/*.ts` files. `drizzle-kit generate` produces SQL in `src/db/migrations/`. A `migrate.ts` script uses `drizzle-orm/neon-http/migrator` against `DATABASE_DIRECT_URL` (non-pooled, as recommended by Neon docs).

**When to use:** Schema changes always go through generate → migrate. Never use `drizzle-kit push` in production.

**Example:**
```typescript
// src/db/client.ts
// Source: Bun + Neon + Drizzle official guide
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

const sql = neon(process.env.DATABASE_URL!)
export const db = drizzle(sql, { schema })

// src/db/migrate.ts
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { migrate } from 'drizzle-orm/neon-http/migrator'

async function main() {
  // Migrations MUST use direct URL, not pooled
  const sql = neon(process.env.DATABASE_DIRECT_URL!)
  const db = drizzle(sql)
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  console.log('Migrations applied')
  process.exit(0)
}
main()
```

### Anti-Patterns to Avoid

- **Inline logic in `index.ts`:** The plugin mandate means `index.ts` only calls `.use()` — never add routes, hooks, or DB logic there.
- **Pooled URL for LISTEN/NOTIFY:** `@neondatabase/serverless` connections are HTTP-based and stateless. Neon's connection pooler (PgBouncer) kills idle connections. LISTEN requires a persistent `pg.Client` on `DATABASE_DIRECT_URL`.
- **Global lifecycle scope without intent:** Elysia lifecycles default to `local` scope. Auth middleware must use `{ as: 'scoped' }` or `{ as: 'global' }` explicitly or it won't protect routes in parent plugins.
- **Unnamed plugins used in multiple places:** Without `name`, Elysia re-initializes the plugin on every `.use()`. Always name auth, db, and shared plugins.
- **Breaking method chains:** Elysia requires chaining for type inference. `app.state(...)` then `app.get(...)` on separate lines breaks TypeScript types.
- **Using `drizzle-kit push` for migrations:** `push` directly alters the DB without generating migration files — never use in production, migrations must be versioned in files.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session management + token rotation | Custom JWT refresh logic | Better Auth built-in session handling | Edge cases: clock skew, concurrent refresh, invalidation — BA handles all |
| Password hashing | Custom bcrypt wrapper | Better Auth (uses scrypt internally) | Wrong hash parameters, timing attacks — BA is battle-tested |
| Migration state tracking | Custom `applied_migrations` table | Drizzle Kit `migrate()` function | Uses `__drizzle_migrations` table; handles concurrent deploys, checksums |
| TypeBox schema from Drizzle | Manual re-declaration of schemas | `drizzle-typebox` `createInsertSchema`/`createSelectSchema` | Keeps types in sync; prevents schema drift between DB and validation |
| WebSocket connection ID mapping | Custom UUID assignment | Use `ws.id` from Elysia's WebSocket context | Bun's WS server assigns IDs; no need for external maps |

**Key insight:** Better Auth abstracts the session/token lifecycle completely — `auth.api.getSession({ headers })` is the single call needed; any custom token parsing duplicates work already done securely inside BA.

---

## Common Pitfalls

### Pitfall 1: Using Pooled URL for LISTEN/NOTIFY

**What goes wrong:** Neon's serverless driver uses HTTP under the hood. The `@neondatabase/serverless` WebSocket mode uses the Neon proxy which breaks long-lived LISTEN connections after idle timeout. NOTIFY events are silently dropped.

**Why it happens:** Developers use one `DATABASE_URL` for everything. Neon provides two distinct URLs for a reason.

**How to avoid:** The LISTEN hub in `src/plugins/ws/listener.ts` must explicitly use `process.env.DATABASE_DIRECT_URL` with a raw `pg.Client`, never the pooled URL.

**Warning signs:** NOTIFY events work initially then stop after ~5 minutes of inactivity.

### Pitfall 2: Elysia Plugin Scope Not Exported

**What goes wrong:** Auth middleware defined inside `authPlugin` with default `local` scope does not protect routes in other plugins that `.use(authPlugin)`. The `beforeHandle` runs only for routes defined inside `authPlugin` itself.

**Why it happens:** Elysia isolates lifecycle hooks by default — this is intentional for modularity.

**How to avoid:** Use `{ as: 'scoped' }` on derive/resolve in auth plugin so it propagates to the parent plugin. Or use the macro pattern (which is explicit per-route).

**Warning signs:** Protected routes return 200 without a token; auth check never fires.

### Pitfall 3: TypeBox Version Symbol Conflict with drizzle-typebox

**What goes wrong:** `drizzle-typebox` brings in its own version of `@sinclair/typebox`. If it differs from Elysia's pinned version, `Symbol` conflicts cause runtime errors like "Expected TSchema".

**Why it happens:** Multiple TypeBox instances in node_modules with different internal Symbols.

**How to avoid:** Check Elysia's pinned TypeBox version (`grep "@sinclair/typebox" node_modules/elysia/package.json`) and add an `overrides` entry in `package.json` to force the same version.

**Warning signs:** `createInsertSchema` output doesn't validate correctly in Elysia route definitions.

### Pitfall 4: Better Auth Role Field Not Available in Session by Default

**What goes wrong:** `auth.api.getSession()` returns a session object; the `role` field from `additionalFields` may not be present in the session unless explicitly included.

**Why it happens:** Better Auth's session object follows its core schema; additional fields on the user table must be explicitly projected.

**How to avoid:** When configuring `additionalFields`, verify that the session resolved in `authPlugin` includes `user.role`. If not, perform a DB lookup by `userId` in the middleware. Alternatively use Better Auth's session customization to include the field in the token.

**Warning signs:** `user.role` is `undefined` in middleware even after login.

### Pitfall 5: Drizzle Infinite Type Instantiation with drizzle-typebox

**What goes wrong:** Nesting `createInsertSchema(...)` directly inside `t.Omit(...)` causes TypeScript error "Type instantiation is possibly infinite".

**Why it happens:** TypeBox and drizzle-typebox both generate deeply nested generic types; combining them inline exceeds TypeScript's instantiation depth.

**How to avoid:** Always assign `createInsertSchema(table.x)` to a variable first, then pass the variable to `t.Omit` / `t.Pick`.

**Warning signs:** TypeScript compile error on schema files; `tsc --noEmit` fails.

### Pitfall 6: Migrations Use Pooled URL — Cause Errors on Neon

**What goes wrong:** Running `migrate()` against the pooled `DATABASE_URL` can fail with "prepared statement does not exist" or timeout errors on Neon.

**Why it happens:** Neon's pooler (PgBouncer in transaction mode) intercepts prepared statements. Drizzle migrations use extended query protocol internally.

**How to avoid:** The `migrate.ts` script must always use `DATABASE_DIRECT_URL`, not `DATABASE_URL`. Document this in the script's header comment.

**Warning signs:** `bun run db:migrate` succeeds locally but fails on Neon cloud.

---

## Code Examples

Verified patterns from official sources and skill files:

### Drizzle Schema File (orders domain)
```typescript
// src/db/schema/orders.ts
// Source: drizzle-orm/pg-core docs + project CONTEXT.md column specs
import { pgTable, uuid, pgEnum, numeric, timestamp, integer } from 'drizzle-orm/pg-core'

export const orderStatusEnum = pgEnum('order_status', [
  'pending', 'confirmed', 'preparing', 'ready_for_pickup',
  'picked_up', 'delivered', 'cancelled'
])

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull(),
  status: orderStatusEnum('status').notNull().default('pending'),
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull(),
  tenantId: uuid('tenant_id'),  // nullable — schema-ready for multi-tenancy
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  menuItemId: uuid('menu_item_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull()
})
```

### drizzle.config.ts
```typescript
// Source: Drizzle + Neon official tutorial
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema',  // folder — drizzle-kit reads all .ts files
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_DIRECT_URL!  // direct URL required for kit
  }
})
```

### Better Auth Setup with Drizzle Adapter + Role Field
```typescript
// src/plugins/auth/better-auth.ts
// Source: better-auth.com/docs/adapters/drizzle + /docs/concepts/database
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '../../db/client'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'customer',
        input: false  // users cannot set role at signup
      }
    }
  }
})
```

### Global Error Handler (Elysia onError)
```typescript
// Attach to root Elysia instance in index.ts
// Source: elysiajs.com + project CONTEXT.md error contract
import { Elysia } from 'elysia'

app.onError(({ code, error, status }) => {
  if (code === 'VALIDATION') {
    return status(422, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: (error as any).all ?? []
    })
  }
  if (code === 'NOT_FOUND') {
    return status(404, { error: 'NOT_FOUND', message: 'Resource not found' })
  }
  console.error('[server-error]', error)
  return status(500, { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
})
```

### WebSocket Hub Plugin
```typescript
// src/plugins/ws/index.ts
// Source: elysiajs skill references/websocket.md + project CONTEXT.md topology
import { Elysia } from 'elysia'
import { startListener, subscribe, unsubscribe } from './listener'

// Channel connection registry — Map<channelName, Set<WebSocket>>
const channels = new Map<string, Set<any>>()

export function dispatch(channel: string, payload: unknown) {
  const sockets = channels.get(channel)
  if (!sockets) return
  const msg = JSON.stringify(payload)
  for (const ws of sockets) ws.send(msg)
}

export const wsPlugin = new Elysia({ name: 'ws-hub', prefix: '/ws' })
  .ws('/:channel', {
    beforeHandle({ headers, status }) {
      const token = headers.authorization?.replace('Bearer ', '')
      if (!token) return status(401)
      // TODO: verify token with auth.api.getSession in Plan 01-02
    },
    open(ws) {
      const channel = ws.data.params.channel
      if (!channels.has(channel)) channels.set(channel, new Set())
      channels.get(channel)!.add(ws)
    },
    close(ws) {
      const channel = ws.data.params.channel
      channels.get(channel)?.delete(ws)
    }
  })

// Called once at server start
startListener()
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hand-rolled JWT auth | Better Auth framework | 2023-2024 | Eliminates session edge cases; Drizzle adapter auto-generates tables |
| `typeorm` / `prisma` for Neon | Drizzle ORM | 2022-2024 | Drizzle is SQL-first, lighter, official Neon partner |
| `pg-listen` for LISTEN/NOTIFY | Raw `pg.Client` with custom backoff | pg-listen stale since 2020 | More control, no unmaintained dependency, Bun-compatible |
| Functional Elysia plugins `(app: Elysia) => app` | `new Elysia({ name })` class instance | Elysia ≥1.0 | Better type inference, proper deduplication via `name` |
| `drizzle-kit push` in development | `drizzle-kit generate` + `migrate()` | Ongoing best practice | Versioned migration files; production-safe; idempotent |

**Deprecated/outdated:**
- `pg-listen`: Last release 2020, no Bun compat documented — use raw `pg.Client` with custom reconnect
- Functional plugin pattern `(app) => app.state(...)`: Still works but Elysia docs recommend class-based `new Elysia()` for better types
- `drizzle-kit push`: Development shortcut that bypasses migration file generation — never use for tracked schema

---

## Open Questions

1. **Better Auth role field in session object**
   - What we know: `additionalFields` adds `role` to the `user` table; `auth.api.getSession()` returns a session with nested `user` object
   - What's unclear: Whether `user.role` is automatically included in the session response without additional config
   - Recommendation: In Plan 01-02, explicitly verify by calling `getSession` after login and logging the full response. If `role` is absent, add a DB lookup by `userId` in the `authPlugin` macro resolve step.

2. **Elysia 1.4.27 WebSocket `beforeHandle` — HTTP 401 before upgrade**
   - What we know: The skill's websocket.md shows `beforeHandle` in WS routes returning `status(401)`
   - What's unclear: Whether returning a status code from `beforeHandle` in a WS route actually prevents the WebSocket upgrade (returning HTTP 401) or is a no-op after the upgrade
   - Recommendation: In Plan 01-03, add an integration test that sends a WS connection without a token and asserts the HTTP response is 401, not a WS handshake.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bun test (built-in, `bun:test`) |
| Config file | None — Bun test runs automatically from `test/` directory |
| Quick run command | `bun test` |
| Full suite command | `bun test --coverage` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | `bun run db:migrate` applies all migrations idempotently | smoke | `bun test test/db/migrations.test.ts` | ❌ Wave 0 |
| INFRA-02 | POST with invalid body returns 422 with `details` array | unit | `bun test test/plugins/validation.test.ts` | ❌ Wave 0 |
| INFRA-03 | `POST /auth/sign-in` with valid credentials returns session with role | integration | `bun test test/plugins/auth.test.ts` | ❌ Wave 0 |
| INFRA-04 | Unprotected request to protected route returns 401; wrong role returns 403 | unit | `bun test test/plugins/auth.test.ts` | ❌ Wave 0 |
| INFRA-05 | `GET /health` returns Neon status; WS hub logs pg_notify within 1s | integration | `bun test test/plugins/ws.test.ts` (partial) | ❌ Wave 0 |

Note: INFRA-05 WebSocket LISTEN/NOTIFY latency test (1-second assertion) requires a live Neon connection; mark as integration test requiring `DATABASE_DIRECT_URL` env var. The `GET /health` portion is a unit test using Elysia's `.handle()` with a mocked DB.

### Sampling Rate
- **Per task commit:** `bun test` (all unit tests, skipping integration if no DB)
- **Per wave merge:** `bun test --coverage`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/plugins/auth.test.ts` — covers INFRA-03, INFRA-04
- [ ] `test/plugins/validation.test.ts` — covers INFRA-02
- [ ] `test/plugins/health.test.ts` — covers INFRA-05 (health endpoint, mocked DB)
- [ ] `test/plugins/ws.test.ts` — covers INFRA-05 (WS hub, integration only)
- [ ] `test/db/migrations.test.ts` — covers INFRA-01 (smoke: migrate is idempotent)
- [ ] No framework install needed — `bun:test` is built into Bun

---

## Sources

### Primary (HIGH confidence)
- ElysiaJS skill file `.agents/skills/elysiajs/` — `SKILL.md`, `references/plugin.md`, `references/websocket.md`, `references/testing.md`, `integrations/better-auth.md`, `integrations/drizzle.md`
- [Drizzle + Neon official tutorial](https://orm.drizzle.team/docs/get-started/neon-new) — packages, config, driver differences
- [Bun + Neon + Drizzle guide](https://bun.com/docs/guides/ecosystem/neon-drizzle) — Bun-specific setup
- [Neon Drizzle Migrations guide](https://neon.com/docs/guides/drizzle-migrations) — direct URL requirement for migrations
- [Better Auth database docs](https://better-auth.com/docs/concepts/database) — core tables, additionalFields
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle) — adapter setup
- [Better Auth admin plugin](https://better-auth.com/docs/plugins/admin) — role storage format (comma-separated string)

### Secondary (MEDIUM confidence)
- [pg-listen GitHub](https://github.com/andywer/pg-listen) — verified as unmaintained (last release 2020); raw `pg.Client` recommended instead
- [node-postgres LISTEN issue #967](https://github.com/brianc/node-postgres/issues/967) — confirms LISTEN requires dedicated non-pooled client

### Tertiary (LOW confidence)
- Bun + `pg` LISTEN/NOTIFY compatibility — no official statement found; Bun claims Node.js compatibility for npm packages; treating as compatible until proven otherwise. Plan 01-03 should verify first.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified against official Neon, Drizzle, Better Auth, and Bun docs
- Architecture: HIGH — plugin patterns from ElysiaJS skill (verified against elysiajs.com); LISTEN/NOTIFY pattern from pg docs
- Pitfalls: HIGH — TypeBox conflict from skill file; pooled URL limitation from Neon official docs; scope leak from Elysia docs

**Research date:** 2026-03-15
**Valid until:** 2026-04-15 (30 days — stack is stable; Better Auth and Elysia have active release cycles, re-verify before Phase 2)
