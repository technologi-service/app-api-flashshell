---
phase: 05-payments
plan: "01"
subsystem: payments
tags: [stripe, payment-intents, migration, consumer]
dependency_graph:
  requires: []
  provides: [payment-intent-creation, payment_intents-migration]
  affects: [consumer-order-creation, kds-notify-flow]
tech_stack:
  added: [stripe@20.4.1]
  patterns: [stripe-payment-intent, pg-pool-direct-url, drizzle-migration]
key_files:
  created:
    - src/db/migrations/0005_payment_intents.sql
    - src/db/migrations/meta/0005_snapshot.json
    - src/plugins/payments/service.ts
  modified:
    - package.json
    - bun.lock
    - src/db/migrations/meta/_journal.json
    - src/plugins/consumer/index.ts
    - src/plugins/consumer/service.ts
    - test/plugins/consumer.test.ts
    - .env.example
decisions:
  - "Manually crafted 0005_payment_intents.sql because db:generate produced wrong diff (snapshots 0003/0004 missing, causing Drizzle to diff from 0002 snapshot and generate duplicate ALTER TABLE orders instead of CREATE TABLE payment_intents)"
  - "Kept generated 0005_snapshot.json (correct full-schema state); only replaced the SQL file"
  - "Removed created_at from INSERT RETURNING clause in createOrder since it was only used by the removed KDS pg_notify block"
metrics:
  duration_minutes: 5
  completed_date: "2026-03-18"
  tasks_completed: 2
  files_modified: 7
---

# Phase 05 Plan 01: Stripe Payment Intent Setup Summary

**One-liner:** Stripe SDK installed, payment_intents migration created, POST /consumer/orders/:id/pay returns clientSecret, and createOrder now inserts orders as 'pending' with KDS notify removed.

## What Was Built

- **Stripe SDK:** stripe@20.4.1 installed (Fetch API internals, Bun compatible)
- **Migration 0005:** `CREATE TABLE payment_intents` with `stripePaymentIntentId UNIQUE` and `idempotencyKey UNIQUE` constraints (idempotency guard for CONS-05)
- **Payment service:** `src/plugins/payments/service.ts` exports `createPaymentIntent(orderId, customerId)` and `stripe` instance
- **Pay route:** `POST /consumer/orders/:id/pay` validates UUID params, calls `createPaymentIntent`, returns `{ clientSecret }` or 404/409/400
- **Order status correction:** `createOrder` now inserts `'pending'` (not `'confirmed'`); KDS pg_notify removed and deferred to Plan 05-02 webhook handler
- **Test coverage:** 3 new tests for pay route (200 success, 404 not found, 409 not pending); existing order creation test updated to expect `status: 'pending'`

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Install Stripe, generate migration, create payment service, update .env.example | 341075c |
| 2 | Add POST /orders/:id/pay route and change createOrder to insert 'pending' | 5139155 |

## Decisions Made

1. **Manual SQL migration over db:generate output:** `db:generate` produced a wrong diff because snapshots 0003 and 0004 were missing from `meta/`. Drizzle compared from the 0002 snapshot (which already contained payment_intents) and generated duplicate `ALTER TABLE orders` columns instead of `CREATE TABLE payment_intents`. Solution: manually wrote the correct DDL and kept the auto-generated snapshot (which correctly reflects full schema state).

2. **Removed `created_at` from RETURNING clause:** The `created_at` column was only fetched to pass into the KDS pg_notify payload. Since pg_notify is removed from createOrder in this plan, the RETURNING clause and corresponding variable were cleaned up.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed incorrect Drizzle migration output**
- **Found during:** Task 1
- **Issue:** `bun run db:generate` produced `0005_numerous_jean_grey.sql` containing `ALTER TABLE orders ADD COLUMN courier_id, delivery_address` (duplicate of 0003) instead of `CREATE TABLE payment_intents`. Root cause: migration snapshots for 0003 and 0004 are missing from `meta/`, causing Drizzle to diff from the 0002 snapshot which predates those columns but already contains the payment_intents table definition.
- **Fix:** Deleted incorrect SQL file, manually wrote `0005_payment_intents.sql` with correct `CREATE TABLE payment_intents` DDL matching the Drizzle schema. Kept the auto-generated `0005_snapshot.json` (it correctly represents full schema end state). Updated journal tag from `0005_numerous_jean_grey` to `0005_payment_intents`.
- **Files modified:** `src/db/migrations/0005_payment_intents.sql`, `src/db/migrations/meta/_journal.json`
- **Commit:** 341075c

## Self-Check: PASSED

- FOUND: src/db/migrations/0005_payment_intents.sql
- FOUND: src/plugins/payments/service.ts
- FOUND: src/plugins/consumer/index.ts
- FOUND: commit 341075c (feat(05-01): install Stripe SDK...)
- FOUND: commit 5139155 (feat(05-01): add POST /orders/:id/pay route...)
