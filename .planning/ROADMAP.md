# Roadmap: FlashShell Engine

## Overview

Five phases build the FlashShell backend from a bare Bun + Elysia bootstrap to a fully operational dark kitchen engine. Phase 1 lays the schema, auth, and WebSocket infrastructure that all subsequent phases require. Phase 2 delivers the irreducible core value: an order created on the consumer side reaches the kitchen screen in under 500ms. Phase 3 adds the delivery layer. Phase 4 adds admin visibility and automatic stock control. Phase 5 wires in the payment processor — isolated last to prevent external integration uncertainty from blocking domain logic development.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Foundation** - Database schema, auth middleware, WebSocket hub infrastructure (completed 2026-03-15)
- [ ] **Phase 2: Core Order Pipeline** - Consumer order creation + KDS real-time delivery (the 500ms SLA)
- [x] **Phase 3: Logistics** - Courier pickup list, GPS broadcast, delivery state machine (completed 2026-03-18)
- [x] **Phase 4: Admin and Control** - Active order dashboard, stock alerts, cash flow report (completed 2026-03-18)
- [ ] **Phase 5: Payments** - Stripe integration, webhook idempotency, order confirmation flow

## Phase Details

### Phase 1: Foundation
**Goal**: The technical bedrock is in place — every other phase can be built on top without retrofitting
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05
**Success Criteria** (what must be TRUE):
  1. `GET /health` returns 200 with Neon connectivity status and server uptime
  2. A request to any protected endpoint without a valid Better Auth token receives a 401 with a descriptive error body
  3. A request with a valid token but insufficient role (e.g., `customer` hitting a chef-only endpoint) receives a 403
  4. The WebSocket hub is connected to Neon via `DATABASE_DIRECT_URL`, and a manual `NOTIFY test_channel` in psql causes the hub to log the event within 1 second
  5. All database tables exist in Neon with migrations tracked in version-controlled files; `bun run db:migrate` is idempotent
**Plans**: 3 plans

Plans:
- [x] 01-01: Schema, migrations, and Drizzle ORM setup
- [ ] 01-02: Better Auth integration with role-based middleware
- [ ] 01-03: WebSocket hub with Neon LISTEN/NOTIFY and supervised reconnection

### Phase 2: Core Order Pipeline
**Goal**: A customer can browse the menu and place an order; the chef sees it on the KDS screen in under 500ms
**Depends on**: Phase 1
**Requirements**: CONS-01, CONS-02, CONS-03, CONS-06, CONS-07, KDS-01, KDS-02, KDS-03, KDS-04, KDS-05
**Success Criteria** (what must be TRUE):
  1. Authenticated customer calls `GET /consumer/menu` and receives all active items with current availability; an item toggled inactive by the chef no longer appears as available
  2. Authenticated customer submits `POST /consumer/orders` with two items; the order is created in the database with status `pending`, stock is reserved atomically, and two concurrent requests for the last unit of stock result in exactly one success and one rejection
  3. Authenticated chef receives a WebSocket push event within 500ms of a new order being created, containing the order ID and items
  4. Chef calls `PATCH /kds/orders/:id/items/:itemId` to move an item through `preparing` → `ready`; customer subscribed via WebSocket receives each status change in real time
  5. Chef calls `PATCH /kds/menu/:itemId/availability` to toggle a dish inactive; the menu endpoint immediately reflects the change for all subsequent customer requests
**Plans**: 3 plans

Plans:
- [ ] 02-01-PLAN.md — Migration (item_status) + Flash-Consumer plugin (GET /menu, POST /orders)
- [ ] 02-02-PLAN.md — Flash-KDS plugin (order queue, item status controls, availability toggle)
- [ ] 02-03-PLAN.md — Order history endpoint, plugin wiring in index.ts, concurrency integration test

### Phase 3: Logistics
**Goal**: A courier can pick up ready orders, and the customer sees the courier's live position until delivery
**Depends on**: Phase 2
**Requirements**: LOGI-01, LOGI-02, LOGI-03, LOGI-04
**Success Criteria** (what must be TRUE):
  1. Authenticated courier calls `GET /logistics/orders/ready` and receives only orders with status `ready_for_pickup`
  2. Courier app pushes GPS coordinates to `POST /couriers/location`; the coordinate is persisted to the database at most every 30 seconds and broadcast via WebSocket to the customer who has that courier's active order
  3. Customer subscribed to their order WebSocket channel receives live GPS coordinate updates from the courier without polling
  4. Courier calls `PATCH /logistics/orders/:id/status` to advance state from `picked_up` to `delivered`; the customer and admin both receive a WebSocket notification for each transition
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md — Migration + schema + consumer extension + logistics plugin (pickup list, delivery state machine)
- [ ] 03-02-PLAN.md — Couriers plugin (GPS ingestion + broadcast), plugin wiring, concurrency integration test

### Phase 4: Admin and Control
**Goal**: Admin has full operational visibility — live order board, automatic stock deductions, low-stock alerts, and cash flow summary
**Depends on**: Phase 3
**Requirements**: CTRL-01, CTRL-02, CTRL-03, CTRL-04
**Success Criteria** (what must be TRUE):
  1. When an order transitions to `confirmed`, the ingredient stock quantities in the database are decremented automatically by a PostgreSQL trigger without any application-layer code path executing the deduction
  2. Admin subscribed to the control WebSocket channel receives an alert within 2 seconds of any ingredient's stock falling below its configured critical threshold
  3. Admin calls `GET /control/orders/active` and receives all orders with status not in `{delivered, cancelled}`; the list updates in real time via WebSocket when any order changes state
  4. Admin calls `GET /control/reports/cashflow?from=DATE&to=DATE` and receives total confirmed revenue versus total stock cost consumed in that period
**Plans**: 2 plans

Plans:
- [ ] 04-01-PLAN.md — Flash-Control plugin (active order dashboard, cash flow report)
- [ ] 04-02-PLAN.md — Stock deduction trigger migration and low-stock alert integration tests

### Phase 5: Payments
**Goal**: The payment loop is closed — customers pay via Stripe before their order is confirmed, and duplicate webhook deliveries never create duplicate orders
**Depends on**: Phase 2
**Requirements**: CONS-04, CONS-05
**Success Criteria** (what must be TRUE):
  1. Authenticated customer calls `POST /consumer/orders/:id/pay` and receives a Stripe Payment Intent URL to complete checkout
  2. Stripe delivers a `payment.approved` webhook; the order status changes from `pending` to `confirmed`, and the customer's WebSocket channel receives the confirmation
  3. Stripe delivers the same `payment.approved` webhook a second time (retry simulation); the order status does not change and no duplicate order is created
  4. A webhook with an invalid HMAC-SHA256 signature is rejected with 400 before any database write occurs
**Plans**: 2 plans

Plans:
- [ ] 05-01-PLAN.md — Stripe SDK + payment_intents migration + POST /orders/:id/pay + createOrder status change to 'pending'
- [ ] 05-02-PLAN.md — Webhook endpoint with HMAC verification, idempotency guard, WS notification, plugin wiring

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete   | 2026-03-15 |
| 2. Core Order Pipeline | 2/3 | In Progress|  |
| 3. Logistics | 2/2 | Complete   | 2026-03-18 |
| 4. Admin and Control | 2/2 | Complete   | 2026-03-18 |
| 5. Payments | 1/2 | In Progress|  |
