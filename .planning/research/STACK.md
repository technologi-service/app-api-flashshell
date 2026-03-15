# Technology Stack

**Project:** FlashShell Engine (Dark Kitchen Backend)
**Researched:** 2026-03-15
**Confidence:** MEDIUM (Bun/Elysia/Drizzle/Neon: HIGH — confirmed from installed packages and training knowledge through Aug 2025. Auth and payments: MEDIUM — based on training data + ecosystem evidence, no live verification possible during this research session.)

---

## Recommended Stack

### Core (Non-Negotiable — Already Decided)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Bun | 1.3.10+ | Runtime + package manager | Constraint. Native WebSocket, ~3x faster cold starts than Node |
| Elysia | 1.4.27 | HTTP framework | Constraint. Designed for Bun, ships `./ws` and `./adapter/bun` as first-class exports |
| TypeScript | 5.8+ | Type safety | Strict mode; Elysia's type inference is a core feature |
| Neon | serverless PostgreSQL | Primary data store | Constraint. LISTEN/NOTIFY + HTTP driver + connection pooling built in |

### Database Driver

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@neondatabase/serverless` | ^0.10 | Neon HTTP + WebSocket driver | Official Neon driver; uses WebSocket transport for persistent connections, HTTP for one-shot queries. Bun-compatible (pure JS, no native addons). Required for LISTEN/NOTIFY via the `Pool` class |

**Do NOT use:** `node-postgres` (`pg`) directly — it requires Node.js-specific net APIs that are partially shimmed in Bun. The Neon serverless driver wraps `pg` internally with WebSocket transport that avoids these issues. Confirmed from Neon official docs (training data).

### ORM / Query Builder

**Recommendation: Drizzle ORM**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `drizzle-orm` | ^0.41 | Type-safe SQL queries | Zero native addons; pure TypeScript; Neon adapter ships in box; schema-as-code approach avoids migration file hell |
| `drizzle-kit` | ^0.30 | Schema migrations | CLI-based, runs in Bun without issues |

**Why Drizzle over Prisma:**
- Prisma requires a native binary (query engine) that must be built for the target OS. Bun can run Prisma Client 5.x via Node.js compatibility shim, but the engine binary adds ~50MB and cold start latency — unacceptable for a Neon serverless setup where connections are bursty.
- Prisma's `DATABASE_URL` connection string bypasses Neon's recommended WebSocket pooler for serverless, creating `MAX_CLIENTS` errors under concurrent dark kitchen load.
- Drizzle compiles to plain SQL strings executed by the Neon driver. No engine, no binary, zero Bun friction.
- Drizzle's `drizzle-orm/neon-serverless` adapter is the canonical pairing in Neon's own documentation.

**Confidence:** HIGH — Drizzle + Neon serverless is the documented official path.

### Authentication

**Recommendation: Clerk**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@clerk/backend` | ^1.x | Server-side JWT verification + user management | Framework-agnostic SDK; works as plain fetch wrapper in any Bun HTTP handler |
| Clerk Dashboard | — | User provisioning, role metadata, session management | Roles (customer / chef / delivery / admin) stored as `publicMetadata` on Clerk session token |

**Why Clerk over Supabase Auth:**
- Clerk's `@clerk/backend` SDK is framework-agnostic: it needs `fetch` + `crypto` (both native in Bun) and does not import any Node-specific modules. Works in Elysia middleware with a simple JWT verify call.
- Supabase Auth ships as part of `@supabase/supabase-js`, which has deeper Node.js assumptions (http/https modules, node-fetch fallback). Community reports of Bun compatibility issues with the realtime channel — problematic when Neon already owns our realtime layer.
- Clerk's `verifyToken()` from `@clerk/backend` is a pure async function; integrate it as an Elysia `beforeHandle` guard. No middleware package needed.
- Clerk free tier supports 10,000 MAU — sufficient for v1 single-tenant dark kitchen.
- Role-based access maps cleanly: set `publicMetadata.role = "chef"` in Clerk Dashboard; read `sessionClaims.publicMetadata.role` in the Elysia guard.

**Alternative if Clerk pricing becomes a constraint:** `better-auth` (open-source, TypeScript-first, Bun-compatible, self-hostable). Avoid Auth.js / NextAuth — designed for Next.js, requires session database callbacks that fight Elysia's middleware model.

**Confidence:** MEDIUM — Clerk SDK is documented as framework-agnostic; Bun compatibility is inferred from its dependency profile (no native addons). Not live-verified in this session.

### Payments — LATAM

**Recommendation: MercadoPago**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `mercadopago` | ^2.x | Payment collection (AR/MX/BR/CO/CL/PE/UY) | Official SDK; coverage of all major LATAM markets |

**Why MercadoPago over Stripe:**
- MercadoPago processes local payment methods that Stripe cannot: Mercado Crédito installments, cash payment via `rapipago`/`pagofácil` (Argentina), OXXO (Mexico), Boleto Bancário (Brazil), PSE (Colombia). For a dark kitchen targeting Spanish-speaking LATAM, local method coverage is a hard requirement.
- MercadoPago's MDR (merchant discount rate) for Argentina is ~3.99% vs Stripe's 2.9% + 30¢ — but Stripe is not available for direct merchant accounts in Argentina as of 2025 (requires a US entity). MercadoPago is the only tier-1 option that works without a foreign entity.
- The official `mercadopago` v2 SDK is a pure TypeScript/JavaScript package without native addons. Bun-compatible.
- Webhook verification uses HMAC-SHA256 (`x-signature` header) — implement in Elysia as a `beforeHandle` guard with Bun's native `crypto.subtle`.

**MercadoPago v2 SDK — critical note:** The older `mercadopago` v1 SDK (`require('mercadopago').configure(...)`) is deprecated. Use v2 (`import MercadoPagoConfig from 'mercadopago'`). v2 uses the Fetch API internally — Bun-compatible.

**What NOT to use:** Stripe as primary for LATAM. Stripe Connect covers Brazil/Mexico as a platform, but direct merchant onboarding in Argentina is unavailable. Stripe can serve as a secondary processor for international cards if the dark kitchen expands, but MercadoPago should be the v1 default.

**Confidence:** MEDIUM — based on MercadoPago's documented market coverage and v2 SDK architecture (training data). SDK Bun compatibility inferred from lack of native dependencies; not live-verified.

### Real-Time Layer

**Architecture: Neon LISTEN/NOTIFY → Elysia WebSocket broadcast**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Elysia `./ws` | 1.4.27 (built-in) | WebSocket server | Ships as part of Elysia; uses Bun's native `Bun.serve` WebSocket which is the fastest WS implementation on Bun |
| `@neondatabase/serverless` Pool | ^0.10 | PostgreSQL LISTEN/NOTIFY listener | `Pool` with `pg`-compatible `on('notification')` API; one persistent connection for subscriptions |

**Pattern:**
1. On startup, create a dedicated Neon `Pool` client for LISTEN (never released to the pool).
2. Call `LISTEN order_events` (and other channels) once on startup.
3. On `notification` event, parse the JSON payload and broadcast to relevant WebSocket clients via Elysia's `server.publish(channel, data)`.
4. Database writes use separate `@neondatabase/serverless` pool connections + `NOTIFY order_events, '{"order_id": 42}'` at the end of each transaction.

**Why no Redis:** Neon LISTEN/NOTIFY is PostgreSQL-native, zero extra infrastructure, handles the concurrency level of a single-tenant dark kitchen. The 500ms order-to-KDS requirement is achievable: NOTIFY is synchronous with the committing transaction; WS broadcast from Node/Bun is sub-millisecond.

**Elysia WS note:** Elysia 1.4.27 ships a dedicated `./ws/bun` adapter (`dist/ws/bun.mjs`) that uses `Bun.serve`'s native WebSocket protocol — this is the path to use, not the generic `./ws` path which falls back to a compatibility shim. Use `.ws()` on the Elysia instance; Bun handles the upgrade automatically.

**Confidence:** HIGH — confirmed from Elysia 1.4.27 package.json exports and Neon serverless driver documentation patterns.

### GPS Tracking

**Architecture: High-frequency push → PostGIS or GEOMETRY columns in PostgreSQL**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| PostgreSQL `POINT` type (native) | — | Store lat/lng per delivery event | Available in Neon without extensions; sufficient for v1 distance queries |
| PostGIS extension | — | Advanced geo queries (routing, geofencing) | Enable in Neon dashboard; needed only if v2 adds geofencing or ETA calculation |

**GPS data strategy:**
- Delivery app sends coordinates every 5–10 seconds via WebSocket (already connected for order status).
- Do NOT write every GPS update to PostgreSQL — at 0.1Hz per courier, a 10-courier operation generates 6 writes/second. Acceptable for v1, but store only events that matter: position on delivery start, position on delivery completion, periodic snapshot every 30s for audit trail.
- Store current position in a `courier_location` table (upsert by courier_id). This is the live-queryable row for the customer map.
- Use `ST_Distance` from PostGIS OR manual Haversine formula for distance if PostGIS is not enabled.
- Neon supports PostGIS but it requires enabling the extension via `CREATE EXTENSION postgis`. This is a one-time migration step.

**Do NOT use:** A separate time-series DB (InfluxDB, TimescaleDB) for GPS. Over-engineered for v1 single-tenant. Neon with periodic snapshots is sufficient.

**Confidence:** HIGH — PostgreSQL POINT type and PostGIS are standard, well-documented. Neon PostGIS support confirmed in Neon docs (training data).

### Validation

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@sinclair/typebox` | ^0.34 | Request/response schema validation | Already a peer dependency of Elysia 1.4.27; Elysia's native validation uses TypeBox. Zero additional install. |

**Do NOT add Zod** as a primary validator. Elysia's type inference pipeline is built for TypeBox. Zod works via Elysia's `t.Transform` adapter but loses compile-time end-to-end type inference, which is the main reason to use Elysia over Fastify.

### Testing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `bun:test` | built-in | Unit + integration tests | Bun's native test runner; Jest-compatible API; no install needed; runs ~3x faster than Vitest on Bun |
| Elysia's `.handle()` | built-in | In-process HTTP testing | Elysia exposes `.handle(Request)` for testing routes without a network socket; no supertest needed |

### Observability

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `pino` | ^9.x | Structured logging | Fastest JSON logger in the Node/Bun ecosystem; Bun-compatible; outputs NDJSON for log aggregation |
| `pino-pretty` | ^11.x | Dev-time log formatting | Dev-only dependency |

**Confidence:** HIGH for Bun + pino compatibility — pino is pure JS with no native addons.

### Linting + Formatting

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Biome | ^1.9 | Lint + format in one tool | Single binary; ~10x faster than ESLint + Prettier; native Bun support (`bunx biome`); replaces both ESLint and Prettier |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| ORM | Drizzle ORM | Prisma | Native binary; cold start latency; Neon connection pooler bypass issues |
| Auth | Clerk | Supabase Auth | Supabase realtime conflicts with our Neon realtime strategy; Node.js module assumptions |
| Auth | Clerk | better-auth | Viable if self-hosting required; less polished role management UI; more setup work |
| Payments | MercadoPago | Stripe | Stripe unavailable as direct merchant in AR; lacks local payment methods |
| Payments | MercadoPago | PayU | Smaller developer ecosystem; less SDK quality; lower LATAM coverage |
| Realtime | Neon LISTEN/NOTIFY | Redis Pub/Sub | Extra infrastructure; Neon handles v1 load; project constraint explicitly prohibits Redis |
| Validation | TypeBox (built-in) | Zod | Breaks Elysia's end-to-end type inference |
| Testing | bun:test | Vitest | Vitest is Node-first; bun:test is the same API with native Bun speed |
| Logging | pino | winston | winston is older, heavier, slower; pino is the current standard for high-throughput services |
| Linting | Biome | ESLint + Prettier | Two tools vs one; Biome is 10x faster; growing ecosystem adoption in 2024–2025 |

---

## Installation

```bash
# Database driver
bun add @neondatabase/serverless

# ORM
bun add drizzle-orm
bun add -D drizzle-kit

# Auth
bun add @clerk/backend

# Payments
bun add mercadopago

# Logging
bun add pino
bun add -D pino-pretty

# Linting (dev)
bun add -D @biomejs/biome
```

---

## Environment Variables Required

```bash
# Neon
DATABASE_URL="postgresql://..."           # Standard connection string
DATABASE_DIRECT_URL="postgresql://..."    # Direct URL (bypasses pooler, for migrations)

# Clerk
CLERK_SECRET_KEY="sk_..."
CLERK_PUBLISHABLE_KEY="pk_..."

# MercadoPago
MERCADOPAGO_ACCESS_TOKEN="APP_USR-..."
MERCADOPAGO_WEBHOOK_SECRET="..."

# App
PORT=3000
NODE_ENV=development
```

---

## Bun Compatibility Notes

All recommended packages have been selected specifically for Bun compatibility. Key criteria applied:
- No native addons (`.node` binaries)
- No Node.js-specific built-in module reliance (`http`, `https`, `net`, `tls`) beyond what Bun shims
- Uses Fetch API or WebSocket where possible (both native in Bun)
- Tested or documented as Bun-compatible in package README or official docs

Packages that would NOT work reliably on Bun and were excluded:
- `prisma` v5 — requires native query engine binary
- `node-postgres` (`pg`) standalone — `net.Socket` issues under Bun (mitigated by using `@neondatabase/serverless` which wraps pg with WebSocket transport)
- `passport` — designed for Express middleware chain; conflicts with Elysia's plugin model
- `express` or `fastify` adapters — not applicable; Elysia is the constraint

---

## Sources

- Elysia 1.4.27 `package.json` (installed in repo) — confirms `./ws/bun`, `./adapter/bun` exports
- Neon serverless driver documentation (training data, Aug 2025): `@neondatabase/serverless` as canonical Neon + TypeScript driver
- Drizzle ORM Neon guide (training data): `drizzle-orm/neon-serverless` as official adapter
- Clerk `@clerk/backend` README (training data): framework-agnostic JWT verification API
- MercadoPago v2 SDK (training data): pure fetch-based architecture, LATAM market coverage
- PostgreSQL LISTEN/NOTIFY documentation: standard feature, no version caveat
- Elysia WebSocket docs (training data): `.ws()` uses `Bun.serve` native WS under the hood

**Confidence levels:**
| Area | Level | Reason |
|------|-------|--------|
| Bun + Elysia core | HIGH | Confirmed from installed package.json |
| Drizzle + Neon | HIGH | Official documented pairing per Neon docs |
| Clerk auth | MEDIUM | No native addons in SDK; Bun compat inferred, not live-verified |
| MercadoPago | MEDIUM | v2 SDK architecture known; Bun compat inferred from lack of native deps |
| Neon LISTEN/NOTIFY WS | HIGH | PostgreSQL standard + Neon serverless driver `Pool` API |
| GPS / PostGIS | HIGH | Standard PostgreSQL extensions, Neon support documented |
