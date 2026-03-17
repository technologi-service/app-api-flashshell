# Phase 3: Logistics - Context

**Gathered:** 2026-03-17
**Status:** Ready for planning

<domain>
## Phase Boundary

A courier can pick up ready orders and the customer sees the courier's live GPS position until delivery. Covers: pickup list, courier assignment, GPS ingestion + broadcast, and the delivery state machine (`ready_for_pickup → picked_up → delivered`).

Out of scope: payment processing (Phase 5), stock deductions (Phase 4), multi-order batching, GPS route history analytics, ETA calculation.

</domain>

<decisions>
## Implementation Decisions

### Courier Assignment Model
- `orders` table gets two new columns via a Phase 3 migration: `courier_id` (uuid, nullable, FK to users) and `delivery_address` (text, not null)
- `POST /consumer/orders` (Phase 2 endpoint) must accept a `delivery_address` field in the request body — this is a Phase 3 extension to the Phase 2 endpoint
- Assignment is **first-come-first-served**: PATCH to `picked_up` atomically writes `courier_id = req.userId` and advances the order status. Concurrent attempts get `409 CONFLICT` (order already claimed)
- **One active order per courier**: server rejects PATCH to `picked_up` if the courier already has an order in `picked_up` status
- **Courier can see orders from `preparing` status** (not just `ready_for_pickup`) so they can anticipate and plan — but can only formally claim (transition to `picked_up`) once the order is in `ready_for_pickup`

### Pickup List (GET /logistics/orders/ready)
- Returns orders in status `preparing` OR `ready_for_pickup` where `courier_id IS NULL` (unclaimed)
- Response per order: `id`, `status`, `items` (name + quantity per item), `totalAmount`, `delivery_address`, `createdAt`
- Includes customer delivery address so the courier knows the destination before pickup

### Order Detail (GET /logistics/orders/:id)
- Logistics-specific endpoint, accessible only to `delivery` role
- Returns full order detail for courier view: `id`, `status`, `items`, `totalAmount`, `delivery_address`, `courier_id`, `createdAt`
- Only the assigned courier (or any delivery-role user for `preparing`/`ready_for_pickup` orders) can access

### Delivery State Machine
- Single endpoint: `PATCH /logistics/orders/:id/status` with body `{ status: 'picked_up' | 'delivered' }`
- Valid transitions: `ready_for_pickup → picked_up`, `picked_up → delivered`
- Server enforces: only the assigned courier (`orders.courier_id === req.userId`) can advance the order once claimed
- No cancellation from courier side — if an issue occurs, admin handles it manually
- On `delivered`: order status set to `delivered`, GPS tracking stops automatically (no active order = no broadcast routing)

### WS Notifications on State Transitions
- `picked_up` transition: `{ event: 'order_picked_up', orderId, courierId }` sent to both:
  - `order:{orderId}` — customer's channel
  - `control` — admin broadcast channel
- `delivered` transition: `{ event: 'order_delivered', orderId }` sent to both:
  - `order:{orderId}` — customer's channel
  - `control` — admin broadcast channel
- Both transitions use `pg_notify('flashshell_events', payload)` with `payload.channel` routing (same pattern as Phase 2)

### GPS Ingestion (POST /couriers/location)
- Body: `{ lat: number, lng: number }`
- **Authorization**: must be `delivery` role AND have an active order in `picked_up` status — returns 403 otherwise
- **Throttle**: server-side silently ignore — if `courier_locations.updated_at` is less than 30 seconds ago, skip the upsert and return `200 OK` without writing. No error, no penalty.
- When not throttled: upsert into `courier_locations` by `courier_id` (PK). 1 row per courier, always the current position
- After upsert: immediately broadcast via `pg_notify` to the customer's order channel

### GPS Broadcast Payload
- Channel: `order:{orderId}` (customer is already subscribed from order creation — no new subscription needed)
- Event shape: `{ event: 'courier_location', orderId, lat, lng, timestamp }`
- `orderId` is resolved server-side: look up the courier's active `picked_up` order to find the target channel
- Broadcast stops automatically when order reaches `delivered` — no active order means the routing query returns null

### Claude's Discretion
- Exact Drizzle column types for `delivery_address` (text vs varchar length)
- Index strategy for the `courier_id IS NULL` filter on the pickup list query
- Exact `pg_notify` channel routing implementation for GPS broadcast
- TypeBox schema organization within the logistics plugin
- Whether to use a single `logisticsPlugin` or split into `logisticsPlugin` + `courierPlugin` by prefix

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — LOGI-01, LOGI-02, LOGI-03, LOGI-04: exact acceptance criteria for this phase
- `.planning/ROADMAP.md` Phase 3 success criteria (lines 59–63) — the 4 testable conditions that define done

### Phase context
- `.planning/PROJECT.md` — Plugin pattern mandate, no Redis, Neon LISTEN/NOTIFY architecture, single-tenant v1
- `.planning/phases/01-foundation/01-CONTEXT.md` — Error contract, WS channel topology (`order:{orderId}`, `logistics`, `control`), auth middleware patterns
- `.planning/phases/02-core-order-pipeline/02-CONTEXT.md` — Order state machine, `pg_notify` pattern, `POST /consumer/orders` endpoint (needs `delivery_address` extension)

### Existing schema
- `src/db/schema/orders.ts` — `orders`, `orderStatusEnum` (pending → confirmed → preparing → ready_for_pickup → picked_up → delivered | cancelled)
- `src/db/schema/logistics.ts` — `courierLocations` table (courier_id PK, lat, lng, updated_at)
- `src/plugins/ws/index.ts` — WS hub, channel topology, `pg_notify` fan-out
- `src/plugins/auth/index.ts` — `authPlugin`, `requireRole` factory

No external ADRs or design specs — requirements are fully captured in decisions above and in REQUIREMENTS.md.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugins/auth/index.ts`: `authPlugin` + `requireRole('delivery')` — apply to logistics plugin directly
- `src/plugins/ws/listener.ts`: `pg_notify('flashshell_events', payload)` fan-out — same pattern used for GPS broadcast and state transition notifications
- `src/db/schema/logistics.ts`: `courierLocations` table already defined (upsert-ready with PK on courier_id)
- `src/db/schema/orders.ts`: `orderStatusEnum` already has all needed values including `ready_for_pickup`, `picked_up`, `delivered`

### Established Patterns
- Plugin pattern: `new Elysia({ prefix: '/logistics' })` — mandatory, registered via `.use()` in `index.ts`
- Error responses: `{ error: 'CONFLICT', message: '...', details: [...] }` — established in Phase 1
- TypeBox for request body validation — Elysia validates automatically, returns 422 on failure
- `SELECT FOR UPDATE` for race condition prevention — used in Phase 2 for stock; same pattern applies to courier assignment

### Integration Points
- `src/index.ts`: `// Phase 3+ plugins registered here: .use(logisticsPlugin)` comment already in place
- `src/db/client.ts`: Drizzle pooled client — import for all queries
- `src/plugins/consumer/index.ts`: `POST /consumer/orders` needs a `delivery_address` field added (Phase 3 schema extension)
- Phase 3 migration adds `courier_id` and `delivery_address` columns to `orders` table (do NOT amend Phase 1 or Phase 2 migrations)

</code_context>

<specifics>
## Specific Ideas

- The pickup list shows orders from `preparing` status so couriers can anticipate and plan — not just `ready_for_pickup`. The list filters out already-claimed orders (`courier_id IS NULL`)
- GPS broadcast stops automatically on delivery — no explicit unsubscribe needed. The routing query (find active `picked_up` order for this courier) returns null after `delivered`, so no broadcast fires
- The `delivery_address` column must be added to `orders` at order creation time — `POST /consumer/orders` must accept it. This is a Phase 3 schema extension to a Phase 2 endpoint

</specifics>

<deferred>
## Deferred Ideas

- **Multi-order batching with geo-proximity**: Courier picks up multiple orders if delivery addresses are close and all orders are ready simultaneously. Requires distance calculation logic — its own phase after v1 validation
- **GPS route history for delivery optimization**: Store all GPS coordinates with timestamps for analytics and route analysis. Current design is upsert-only (LOGI-02 constraint: prevent DB bloat). Future phase adds a `courier_location_history` table or similar

</deferred>

---

*Phase: 03-logistics*
*Context gathered: 2026-03-17*
