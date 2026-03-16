# Phase 2: Core Order Pipeline - Context

**Gathered:** 2026-03-16
**Status:** Ready for planning

<domain>
## Phase Boundary

A customer can browse the active menu and place an order; the chef sees it on the KDS screen in under 500ms. This phase delivers the irreducible core value loop: consumer order creation + real-time KDS delivery.

Out of scope: payments (Phase 5), courier pickup (Phase 3), stock triggers (Phase 4). No Stripe in this phase.

</domain>

<decisions>
## Implementation Decisions

### Order State in Phase 2 (without payment)
- `POST /consumer/orders` auto-advances the order from `pending` → `confirmed` atomically in the same transaction — no separate payment step in Phase 2
- The KDS plugin watches `confirmed` orders, not `pending`
- Phase 5 (Stripe) will remove this auto-confirm behavior: `POST /consumer/orders` will instead stay `pending` and return a Payment Intent; the Stripe webhook advances `pending → confirmed`
- The rest of the state machine (`confirmed → preparing → ready_for_pickup → ...`) is untouched by Phase 5 — no KDS code needs updating

### POST /consumer/orders Response
- Returns the full order object on success: `id`, `status` (`confirmed`), `totalAmount`, and `items` array (name, quantity, unitPrice per item)
- Client has everything it needs to display a confirmation screen without a follow-up GET

### Stock Failure Policy
- Reject the **whole order** with `409 CONFLICT` if ANY item fails validation
- Two conditions trigger rejection: item is `isAvailable = false` OR item stock quantity is 0
- Both conditions checked in the same `SELECT FOR UPDATE` query
- Error body identifies which items failed (so client UI can highlight them)
- No partial fulfillment — atomic accept-or-reject only

### KDS Push Payload (new order)
- When an order is confirmed, `pg_notify('flashshell_events', payload)` fires to channel `kds`
- The push payload embeds the full order: `{ event: 'new_order', orderId, createdAt, items: [{ itemId, name, quantity }] }`
- Chef's KDS screen renders the new ticket immediately — no follow-up HTTP call needed

### Consumer WebSocket Events (item updates)
- When chef marks an item status change via PATCH, the consumer's `order:{orderId}` channel receives:
  `{ event: 'item_status_changed', orderId, itemId, status: 'preparing' | 'ready' }`
- Granular item events only — consumer does NOT receive chef-internal order-level transitions
- Consumer does receive an order-level event when the order reaches `ready_for_pickup` (order transitions)

### Item-level Status Tracking
- `order_items` needs a new `item_status` column — **not in Phase 1 schema**, requires a new Drizzle migration
- Item state machine: `pending → preparing → ready` (3 states, no additional)
  - `pending`: item created with the order
  - `preparing`: chef has started this item (KDS-02: PATCH → `preparing`)
  - `ready`: item is done (KDS-03: PATCH → `ready`)
- New migration (0002_add_item_status): do NOT amend the Phase 1 migration

### Order Auto-advance (all items ready)
- When the last item in an order reaches `ready`, the order automatically advances to `ready_for_pickup`
- This is handled application-side in the PATCH /kds/orders/:id/items/:itemId handler — no DB trigger
- The auto-advance fires `pg_notify` to both `kds` (order done) and `logistics` (ready for pickup) channels
- KDS-04 is covered implicitly by auto-advance — no separate PATCH /kds/orders/:id endpoint needed in Phase 2

### Claude's Discretion
- Exact `pg_notify` payload field names beyond what's specified above
- Drizzle column type for item_status (pgEnum vs text with check)
- Index strategy on order_items for the status query
- CONS-07 (order history) endpoint shape — return list with id, status, totalAmount, createdAt per order; pagination optional

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — CONS-01, CONS-02, CONS-03, CONS-06, CONS-07, KDS-01–KDS-05: exact acceptance criteria for this phase
- `.planning/ROADMAP.md` Phase 2 success criteria (lines 43–47) — the 5 testable conditions that define done

### Phase context
- `.planning/PROJECT.md` — Plugin pattern mandate, real-time constraints, no Redis policy
- `.planning/phases/01-foundation/01-CONTEXT.md` — Error contract, WS channel topology, auth middleware patterns, existing schema decisions

### Existing schema
- `src/db/schema/menu.ts` — menuItems, ingredients, menuItemIngredients table definitions
- `src/db/schema/orders.ts` — orders, order_items, orderStatusEnum (pending → confirmed → preparing → ready_for_pickup → picked_up → delivered | cancelled)
- `src/plugins/ws/index.ts` — WS hub, registerSocket/unregisterSocket, channel topology
- `src/plugins/auth/index.ts` — authPlugin, requireRole factory

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugins/auth/index.ts`: `authPlugin` + `requireRole(...roles)` factory — apply to `consumerPlugin` and `kdsPlugin` directly
- `src/plugins/ws/listener.ts`: `pg_notify('flashshell_events', payload)` fan-out via `payload.channel` — call this from order creation and item status update handlers
- `src/db/schema/orders.ts`: `orderStatusEnum` already defined — extend it or reuse for item status enum
- `src/index.ts`: Phase 2 plugin mount comment already in place — `consumerPlugin` and `kdsPlugin` registered here

### Established Patterns
- Plugin pattern: `new Elysia({ prefix: '/consumer' })` / `new Elysia({ prefix: '/kds' })` — mandatory
- Error responses: `{ error: 'CONFLICT', message: '...', details: [...] }` — consistent shape from Phase 1
- TypeBox for request body validation — Elysia validates automatically, returns 422 on failure

### Integration Points
- `src/plugins/ws/listener.ts` — emit function called from domain plugins on state changes
- `src/db/client.ts` — Drizzle pooled client imported by all domain plugins
- `src/index.ts` — `.use(consumerPlugin).use(kdsPlugin)` added here

</code_context>

<specifics>
## Specific Ideas

- The 500ms SLA (KDS-01) is met by embedding the full order in the pg_notify push payload — no round trip from KDS to REST after receiving the event
- Phase 5 integration point is clean: remove the `await db.update(orders).set({ status: 'confirmed' })` line from POST /consumer/orders handler and replace with Stripe Payment Intent return. No other Phase 2 code changes.
- Stock reservation uses `SELECT FOR UPDATE` on `ingredients` rows (CONS-03 requirement) — the row lock prevents two concurrent orders from both passing the stock check on the same ingredient

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-core-order-pipeline*
*Context gathered: 2026-03-16*
