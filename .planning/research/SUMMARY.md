# Project Research Summary

**Project:** FlashShell Engine (Dark Kitchen Backend)
**Domain:** Dark Kitchen Operations — real-time order pipeline with KDS, logistics, and inventory control
**Researched:** 2026-03-15
**Confidence:** MEDIUM-HIGH (core stack HIGH, auth and payments MEDIUM)

## Executive Summary

FlashShell Engine is a single-tenant dark kitchen backend that must handle four operational pillars simultaneously: customer order intake (Flash-Consumer), kitchen display system (Flash-KDS), courier logistics with live GPS (Flash-Logistics), and administrative stock and financial control (Flash-Control). The defining constraint of dark kitchens — no physical point-of-sale, no dining room, no cash fallback — means every failure mode that a traditional restaurant can absorb manually becomes a hard system failure. Stock inconsistency blocks orders, notification loss leaves chefs blind, and GPS absence causes customer churn with no human substitution available.

The recommended architecture is a modular monolith built on Bun + Elysia 1.4.27 with Neon PostgreSQL as both the primary data store and the real-time event bus (LISTEN/NOTIFY). The four operational pillars map cleanly to four Elysia plugins with isolated route prefixes and a shared data access layer. Cross-plugin communication happens exclusively through PostgreSQL triggers emitting NOTIFY events, which the WebSocket hub broadcasts to the appropriate client channels. This design allows each module to be independently tested and, if scale demands it, extracted to a microservice without rewriting domain logic.

The two critical risks to manage proactively are: (1) stock race conditions under concurrent orders, which require `SELECT FOR UPDATE` pessimistic locking on every order creation — READ COMMITTED isolation alone is insufficient; and (2) the LISTEN/NOTIFY connection must use a direct (non-pooled) Neon URL on a dedicated persistent client with supervised reconnection, because a pooled connection silently loses its LISTEN registrations when PgBouncer rotates the physical connection. Both risks are well-understood and fully preventable if addressed at design time, but they are both expensive to retrofit.

---

## Key Findings

### Recommended Stack

The core runtime is Bun 1.3.10+ with Elysia 1.4.27, both already present in the repository and treated as hard constraints. The stack was selected end-to-end for Bun compatibility: no native addon binaries, no Node.js-specific module imports beyond what Bun shims, and preference for Fetch API and WebSocket APIs that Bun implements natively.

The database layer pairs `@neondatabase/serverless` (the official Neon driver with WebSocket transport, avoiding raw `node-postgres` net-socket issues under Bun) with Drizzle ORM (zero native addons, official Neon adapter, compiles to plain SQL). Prisma was explicitly rejected because its query engine binary adds ~50MB and cold-start latency incompatible with Neon serverless. Validation uses Elysia's built-in TypeBox (`@sinclair/typebox`) — mixing Zod breaks Elysia's compile-time end-to-end type inference.

**Core technologies:**
- Bun 1.3.10+ + Elysia 1.4.27: runtime and HTTP framework — hard constraints, fastest Bun-native stack
- `@neondatabase/serverless` ^0.10: Neon PostgreSQL driver — only safe Neon driver for Bun (WebSocket transport, no native addons)
- Drizzle ORM ^0.41 + drizzle-kit ^0.30: ORM and migrations — official Neon pairing, no binary engine
- `@clerk/backend` ^1.x: authentication — framework-agnostic SDK, pure fetch+crypto, Bun-compatible
- `mercadopago` ^2.x (v2 SDK): payments — only LATAM-viable tier-1 processor for Argentina without a foreign entity; v2 uses Fetch API internally
- Elysia `./ws/bun` adapter: WebSocket server — Bun-native, highest throughput
- Neon LISTEN/NOTIFY via dedicated `Pool` connection: real-time event bus — no Redis required for v1 single-tenant load
- `pino` ^9.x: structured logging — fastest JSON logger, Bun-compatible, no native addons
- Biome ^1.9: lint and format — replaces ESLint + Prettier in one binary, `bunx biome` native

**Environment variables required:** `DATABASE_URL` (pooler), `DATABASE_DIRECT_URL` (direct, for LISTEN), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`.

### Expected Features

The 44 table-stakes features cluster into the four pillars and a cross-cutting infrastructure layer. The critical insight from domain research is that the features form a strict dependency chain: stock and ingredient schema must exist before the menu can reflect real availability, the menu must exist before order creation, order creation gates payment, payment gates KDS notification, KDS state gates logistics pickup, and logistics delivery closes the financial record in Flash-Control. This chain determines build order more than feature priority alone.

**Must have (table stakes) — v1:**
- Menu with real-time availability tied to stock (Flash-Consumer)
- Cart and order creation with atomic stock validation (`SELECT FOR UPDATE`) (Flash-Consumer)
- Pre-delivery online payment via MercadoPago with idempotency (Flash-Consumer)
- Order status tracking via WebSocket (Flash-Consumer)
- Courier GPS tracking broadcast to customer (Flash-Consumer / Flash-Logistics)
- KDS real-time order queue via WebSocket — sub-500ms order-to-chef SLA (Flash-KDS)
- KDS item and order status controls (Flash-KDS)
- KDS toggle item availability without admin intervention (Flash-KDS)
- Courier pickup list, GPS push, and delivery state machine (Flash-Logistics)
- Automatic stock decrement on payment confirmation (Flash-Control)
- Low-stock alerts via WebSocket/notification (Flash-Control)
- Basic sales and cash-flow reporting (Flash-Control)
- Auth with four roles (customer / chef / delivery / admin) + RBAC on every endpoint (cross-cutting)
- Authenticated WebSocket handshake (cross-cutting)
- Atomic transactions for payment + stock operations (cross-cutting)
- Structured error handling and health check endpoint (cross-cutting)

**Should have (competitive differentiators) — v1 stretch or early v2:**
- Dynamic delivery ETA based on GPS distance (Haversine approximation acceptable for v1)
- Order history with one-tap re-order (Flash-Consumer)
- Recipe cost auto-calculation for margin visibility (Flash-Control)
- Basic kitchen throughput metrics (avg prep time, orders/hour) (Flash-Control)
- CSV export for external accounting (Flash-Control)
- Post-delivery rating (Flash-Consumer)

**Defer (v2+):**
- Automatic courier assignment (nearest courier algorithm — requires geospatial indexing)
- Multi-order batching per courier
- Proof-of-delivery photo (requires object storage)
- Supplier and cost management
- Multi-kitchen cross-analytics (requires multi-tenancy first)
- ML demand prediction (requires 3+ months of real order data)
- Electronic invoicing integration (AFIP/SAT/SUNAT — country-specific, high cost)

### Architecture Approach

The system uses a modular monolith pattern: one Elysia root app that mounts five plugins (authPlugin, consumerPlugin, kdsPlugin, logisticsPlugin, controlPlugin) plus a WebSocket hub plugin (wsPlugin). All domain plugins share a single data access layer (`src/db/`) containing the Neon connection pool and typed query functions. Plugins do not import each other — cross-pillar communication flows exclusively through PostgreSQL `NOTIFY` events triggered by DB writes, received by the WebSocket hub's dedicated LISTEN connection, and broadcast to the appropriate client channels by role (customer sees `order:{id}`, chefs see `kds`, couriers see `logistics`, admin sees `control`).

**Major components:**
1. `authPlugin` — validates Clerk JWT, injects `ctx.user` (userId + role) into every request context via Elysia `derive`
2. `consumerPlugin` / `kdsPlugin` / `logisticsPlugin` / `controlPlugin` — domain route handlers, each with its own prefix, each self-contained with `authPlugin` as a local dependency for isolated testability
3. `wsPlugin` — single WebSocket hub, one dedicated LISTEN connection to Neon (direct URL, never pooled), channel routing map from event type + payload to subscriber sets
4. `DAL` (`src/db/`) — all SQL queries as typed TypeScript functions; no business logic, no ORM magic; one pool singleton
5. PostgreSQL triggers — `notify_order_change()` on `orders.status` updates, `notify_stock_critical()` on `stock.quantity_available` updates; `pg_notify` payloads are minimal (IDs and event type only, max 8KB limit)

**Key patterns to follow:**
- Plugins declare `authPlugin` internally, not only at root — enables isolated unit testing with mock auth
- NOTIFY payloads contain only IDs and event type; clients fetch full data via REST if needed
- `SELECT ... FOR UPDATE` with consistent lock order (by ID ASC) on every multi-row stock operation
- GPS coordinates stored in separate `delivery_locations` table (INSERT per event, not UPDATE on `orders`) to avoid MVCC dead-tuple bloat on the hot `orders` table
- Dedicated direct-URL `Client` (not pool) for LISTEN, initialized at server startup, never released

### Critical Pitfalls

1. **Stock race condition (lost update)** — Two concurrent orders both read `quantity = 1` at READ COMMITTED isolation and both proceed. Prevention: `SELECT ... FOR UPDATE` with rows locked in consistent ID order inside a single transaction. Must be implemented the moment order creation is built — cannot be retrofitted cheaply.

2. **LISTEN on pooled connection silently breaks** — PgBouncer's transaction-mode pooling rotates physical connections; LISTEN state is session-scoped and is cleared on rotation, with no error emitted. Prevention: always use `DATABASE_DIRECT_URL` for the LISTEN client, keep it as a persistent singleton, add supervised reconnection with exponential backoff and 60-second keepalive queries.

3. **Payment-order inconsistency (double charge or ghost order)** — Client retries or MercadoPago webhook retries create duplicate orders. Prevention: webhook-first order creation using a `payment_intents` state machine (`pending → processing → processed`) with a `UNIQUE` constraint on `external_payment_id`; the webhook handler's first action is an atomic status update that returns 0 rows if already processed.

4. **GPS table bloat from high-frequency writes** — PostgreSQL MVCC creates a dead tuple per UPDATE. At 10 couriers × 0.2Hz, that is 120 dead tuples/minute on a small table. Prevention: write to DB every 30 seconds (every 6th GPS tick), broadcast all ticks directly via WebSocket without persisting; do not index `lat`/`lng` columns to keep updates HOT-eligible; set aggressive autovacuum scale factor on `courier_location`.

5. **Neon scale-to-zero severs the LISTEN connection silently** — TCP is dropped; if the listener has no reconnection logic, subsequent NOTIFY events are lost with no visible error. Prevention: supervised reconnection in the `wsPlugin` startup with exponential backoff (up to 30s); consider disabling scale-to-zero on the production Neon compute for dark kitchen operating hours.

6. **IDOR — courier accessing another courier's orders** — Role check passes but ownership filter is missing from the query. Prevention: every query that returns user-specific data must filter by both role AND `user.id`; build this as a shared utility at project foundation so all modules inherit the pattern.

---

## Implications for Roadmap

Based on the dependency chain from FEATURES.md and the build order from ARCHITECTURE.md, the natural phase structure is:

### Phase 1: Infrastructure Foundation

**Rationale:** Every other phase depends on the database schema, connection layer, trigger infrastructure, and authentication context. Nothing can be built in isolation without these.

**Delivers:** Working Neon schema with migrations, PostgreSQL triggers for NOTIFY, singleton connection pool, LISTEN client with reconnection logic, Clerk JWT auth middleware with role injection, Biome linting configured, pino logging, health check endpoint.

**Addresses:** Auth + RBAC (cross-cutting table stakes), atomic transaction infrastructure, structured error handling.

**Avoids:** Pitfall 2 (LISTEN on pooled URL — establish the direct URL pattern before any listener is written), Pitfall 6 (IDOR — build the ownership check utility here so all plugins inherit it), Pitfall 14 (prepared statement caching — driver configured correctly from the start).

**Research flag:** Standard patterns. Elysia plugin API, Drizzle schema, Neon driver configuration are all well-documented. No additional research needed.

---

### Phase 2: Core Order Pipeline — Flash-Consumer + Flash-KDS

**Rationale:** This is the irreducible value center of the product. The 500ms order-to-KDS SLA is the defining performance requirement. Consumer and KDS are built together because the KDS queue is meaningless without order creation, and order creation is meaningless without KDS receiving it. The WebSocket hub's LISTEN loop is initialized here.

**Delivers:** Menu endpoint with real-time availability, cart-to-order creation with `SELECT FOR UPDATE` stock validation, KDS order queue with WebSocket push, KDS item and order status controls, availability toggle from KDS, WebSocket authentication on handshake.

**Addresses:** Flash-Consumer table stakes (11 features), Flash-KDS table stakes (8 features), WebSocket infrastructure (cross-cutting).

**Avoids:** Pitfall 1 (stock race condition — `SELECT FOR UPDATE` from day one), Pitfall 5 (LISTEN reconnection — supervised reconnect built here), Pitfall 7 (WebSocket drop — full state sync on reconnect for KDS), Pitfall 10 (Zod validation — establish TypeBox-only pattern on first routes).

**Research flag:** Verify Elysia 1.4.27 `ws()` API specifics against official docs at implementation time — ARCHITECTURE.md notes MEDIUM confidence on WebSocket channel routing details. The LISTEN/NOTIFY and `SELECT FOR UPDATE` patterns are HIGH confidence.

---

### Phase 3: Flash-Logistics — Courier and GPS

**Rationale:** Logistics operates on orders in `ready` state, which requires the full consumer-to-KDS cycle from Phase 2 to be functional. GPS broadcasting extends the wsPlugin with a new channel and a new event type.

**Delivers:** Courier pickup list (orders in `ready_for_pickup` state), courier-to-customer GPS broadcast via WebSocket, delivery status state machine (`picked_up → in_transit → delivered`), manual courier assignment by admin, GPS storage strategy (INSERT every 30s, not every push).

**Addresses:** Flash-Logistics table stakes (7 features).

**Avoids:** Pitfall 4 (GPS table bloat — write every 30s, no spatial index on coordinates, HOT-eligible updates from the start), Pitfall 6 (IDOR — courier ownership filter on all logistics queries), Pitfall 13 (Bun `publishToSelf: false` default — design broadcast logic knowing this behavior).

**Research flag:** Standard patterns. GPS coordinate storage and WebSocket broadcast are well-understood. No additional research needed.

---

### Phase 4: Flash-Control — Admin, Stock, and Financials

**Rationale:** Flash-Control is read-heavy, operating on data produced by phases 2 and 3. It does not unblock any operational flow — it observes and reports on it. Building it last means the data it aggregates exists and is trustworthy. The stock alert WebSocket channel extends the wsPlugin here.

**Delivers:** Admin dashboard of all active orders, low-stock alerts via WebSocket, basic sales report (orders and revenue by period), cash flow view (revenue vs. inventory costs), menu price and availability management, user role management.

**Addresses:** Flash-Control table stakes (10 features).

**Avoids:** Pitfall 12 (stock decremented on cancelled/failed orders — stock reservation pattern: reserve on order creation, deduct on payment confirmation, release on cancellation).

**Research flag:** Standard patterns for admin dashboards and SQL aggregation. No additional research needed.

---

### Phase 5: Payments Integration

**Rationale:** Payments are the most externally variable element (LATAM regulatory environment, SDK Bun compatibility, webhook reliability). Deferring payments to Phase 5 allows the full order → kitchen → delivery → admin cycle to be tested end-to-end with manually set `confirmed` status, reducing risk of the payment integration blocking domain logic development. The domain is complete before the payment layer is introduced.

**Delivers:** MercadoPago v2 SDK integration, `payment_intents` state machine table, webhook endpoint with HMAC-SHA256 signature verification (Bun native `crypto.subtle`), idempotency key on payment calls, webhook-first order confirmation flow (`pending → confirmed` triggered by webhook, not by initial HTTP response), stock deduction moved to webhook handler.

**Addresses:** Payment table stakes (Flash-Consumer pillar), idempotency key infrastructure (cross-cutting).

**Avoids:** Pitfall 3 (payment-order inconsistency — webhook-first creation, `payment_intents` deduplication), Pitfall 8 (connection pool exhaustion — no MercadoPago SDK calls inside DB transactions), Pitfall 9 (duplicate orders from MP webhook retries — atomic `status = 'pending'` check before order creation).

**Research flag:** MEDIUM confidence on MercadoPago v2 SDK Bun compatibility. Verify that `mercadopago` v2 has no native addon dependencies at integration time. Verify webhook signature format against current MP docs — `x-signature` header format may differ from training data. This phase warrants a focused research spike before implementation.

---

### Phase Ordering Rationale

- Auth and database infrastructure come first because every handler requires `ctx.user.role` and every query requires a schema to exist.
- Consumer and KDS are co-developed in Phase 2 because the KDS data flow is the system's primary value and testing it requires order creation working.
- Logistics (Phase 3) operates on `ready` state orders, making it a downstream dependency of Phase 2.
- Admin control (Phase 4) aggregates data from phases 2 and 3 — its queries are meaningful only when orders are flowing through the system.
- Payments (Phase 5) are isolated last to prevent external integration uncertainty from blocking domain development. The domain can be fully tested with status manually set to `confirmed` through Phase 4.
- This order mirrors the feature dependency chain documented in FEATURES.md exactly and is consistent with the build order proposed in ARCHITECTURE.md.

### Research Flags

Phases needing deeper research during planning:
- **Phase 5 (Payments):** MercadoPago v2 SDK Bun compatibility needs live verification. Webhook signature format and retry behavior need validation against current MP documentation. Idempotency key API may have changed since training data cutoff.
- **Phase 2 (WebSocket):** Elysia 1.4.27 `ws()` channel routing API specifics — ARCHITECTURE.md flags MEDIUM confidence on this. Verify the exact `ws.subscribe()` / `server.publish()` API against official Elysia docs before writing the wsPlugin.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Drizzle + Neon setup is the official documented pairing. Clerk `@clerk/backend` JWT verification is a standard async function. Well-documented.
- **Phase 3 (Logistics):** GPS storage, WebSocket broadcast, and state machine are standard patterns with HIGH confidence sources.
- **Phase 4 (Admin):** SQL aggregations and admin dashboards are well-understood. No novel integration.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core runtime (Bun + Elysia + Drizzle + Neon serverless driver) confirmed from installed packages and official docs. Auth (Clerk) and payments (MercadoPago v2) are MEDIUM — inferred from SDK architecture, not live-verified in this session. |
| Features | MEDIUM | Features derived from PROJECT.md requirements (primary source) plus domain knowledge of dark kitchen operations (KDS patterns, delivery tracking). Feature prioritization is well-reasoned from domain constraints. External verification of competitive landscape not possible in this session. |
| Architecture | HIGH | Elysia plugin API is stable and documented. PostgreSQL LISTEN/NOTIFY, SELECT FOR UPDATE, and MVCC behaviors are from official PostgreSQL docs (live verified). Order lifecycle states are industry-standard patterns. WebSocket channel routing specifics are MEDIUM — verify against Elysia docs at implementation. |
| Pitfalls | HIGH | PostgreSQL concurrency pitfalls (race conditions, LISTEN/pooler incompatibility, MVCC bloat) sourced from official PostgreSQL docs (live verified). Bun WebSocket behavior sourced from official Bun docs (live verified). Payment idempotency is industry-standard. Neon scale-to-zero behavior is MEDIUM (training data + architectural inference). |

**Overall confidence:** MEDIUM-HIGH

The PostgreSQL and real-time architecture are solid. The primary uncertainty is in the third-party integrations (Clerk Bun compatibility, MercadoPago v2 SDK) — both were selected based on sound architectural reasoning (no native addons, Fetch API internals) but require live verification at implementation time.

### Gaps to Address

- **Clerk `@clerk/backend` Bun compatibility:** Inferred from its dependency profile (no native addons). Verify at Phase 1 by running `bun add @clerk/backend` and checking that `verifyToken()` works in a minimal Bun script. Fallback: `better-auth` (open-source, TypeScript-first, self-hostable).
- **MercadoPago v2 SDK Bun compatibility:** Verify that `mercadopago` v2 imports resolve correctly under Bun and that the Fetch API usage does not hit Bun compatibility issues. Validate webhook signature verification against current MP documentation before Phase 5.
- **Neon scale-to-zero behavior on paid plan:** The reconnection logic in PITFALLS.md covers the free tier behavior. Confirm whether paid plan compute settings allow disabling scale-to-zero entirely — this eliminates the most operationally dangerous failure mode for a dark kitchen running during business hours.
- **Neon connection limits by tier:** Exact connection count limits depend on the Neon plan. Confirm before setting pool `max` value in `src/db/pool.ts`.
- **Elysia 1.4.27 `ws()` pub/sub API:** The ARCHITECTURE.md WebSocket channel routing pattern is conceptually correct but the exact API calls (`ws.subscribe()`, `server.publish()`) need verification against the current Elysia docs — the installed version is 1.4.27 and the pattern is based on training data through August 2025.

---

## Sources

### Primary (HIGH confidence)
- Installed `package.json` (Elysia 1.4.27) — confirmed `./ws/bun` and `./adapter/bun` exports
- PostgreSQL 16 official docs (live verified) — `SELECT FOR UPDATE`, transaction isolation, LISTEN/NOTIFY, MVCC, autovacuum, Row Level Security
- Bun official docs (live verified) — WebSocket server API, `idleTimeout`, `publishToSelf` default
- PROJECT.md (FlashShell Engine) — primary source for feature requirements and operational constraints

### Secondary (MEDIUM confidence)
- Neon official documentation (training data, Aug 2025) — `@neondatabase/serverless` as canonical Neon driver, pooler behavior, LISTEN on direct URL, PostGIS support
- Drizzle ORM Neon guide (training data) — `drizzle-orm/neon-serverless` as official adapter
- Clerk `@clerk/backend` README (training data) — framework-agnostic JWT verification API
- MercadoPago v2 SDK (training data) — Fetch API internals, LATAM market coverage, `x-signature` webhook header
- Elysia documentation (training data) — plugin `.use()` with prefix, `beforeHandle` guards

### Tertiary (LOW confidence / needs live validation)
- MercadoPago webhook retry behavior — idempotency requirements inferred from industry-standard patterns; verify against current MP docs
- Neon exact connection limits by tier — architectural patterns correct, numbers require plan verification

---
*Research completed: 2026-03-15*
*Ready for roadmap: yes*
