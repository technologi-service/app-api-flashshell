---
phase: 05-payments
plan: "02"
subsystem: payments
tags: [stripe, webhook, hmac, idempotency, pg_notify, websocket]
dependency_graph:
  requires: [05-01]
  provides: [stripe-webhook-handler, order-confirmation-flow, payment-idempotency]
  affects: [consumer-order-status, kds-notify-flow, ws-notifications]
tech_stack:
  added: []
  patterns: [stripe-constructEventAsync, raw-body-webhook, pg-pool-transaction, pg_notify-dual-channel, mock-contamination-fix]
key_files:
  created:
    - src/plugins/payments/index.ts
    - test/plugins/payments.test.ts
  modified:
    - src/plugins/payments/service.ts
    - src/index.ts
decisions:
  - "Add createPaymentIntent stub to payments.test.ts mock to prevent Bun 1.3.9 mock.module() contamination in consumer.test.ts when running full suite"
  - "No TypeBox body schema on POST /webhooks/stripe — intentional; schema parsing corrupts raw body before HMAC-SHA256 verification"
  - "txPool uses DATABASE_DIRECT_URL with max:3 — same pattern as consumer/service.ts (PgBouncer transaction mode does not preserve locks)"
metrics:
  duration_minutes: 2
  completed_date: "2026-03-18"
  tasks_completed: 2
  files_modified: 4
---

# Phase 05 Plan 02: Stripe Webhook Handler Summary

**One-liner:** Stripe webhook endpoint with HMAC-SHA256 verification, idempotent payment_intent.succeeded handler that confirms orders and fires pg_notify to consumer WS and KDS channels.

## What Was Built

- **paymentsPlugin:** `POST /webhooks/stripe` — calls `stripe.webhooks.constructEventAsync` with raw body from `request.text()`, returns 400 on invalid signature, routes `payment_intent.succeeded` to `handlePaymentSucceeded`
- **handlePaymentSucceeded:** Transactional handler in `service.ts` — idempotency check via `stripe_payment_intent_id`, INSERT payment_intents, UPDATE orders `pending -> confirmed`, dual `pg_notify` to `order:{orderId}` (consumer WS) and `kds` channels
- **Idempotency:** Duplicate `payment_intent.succeeded` events return `{ received: true, duplicate: true }` with no DB write
- **Test coverage:** 5 tests covering valid webhook, invalid signature, missing signature, idempotent retry, unhandled event type — all pass
- **Plugin wired:** `paymentsPlugin` registered in `src/index.ts` after `controlPlugin`, before `.listen(3000)`
- **OpenAPI tag:** `{ name: 'payments', description: 'Stripe payment webhooks' }` added to documentation

## Tasks Completed

| Task | Name | Commit | Status |
|------|------|--------|--------|
| 1 | Add handlePaymentSucceeded, create paymentsPlugin, write tests | 3a5ad0b | Complete |
| 2 | Wire paymentsPlugin into index.ts, fix mock contamination | 8d92fdd | Complete |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Bun 1.3.9 mock.module() contamination causing consumer.test.ts failure**
- **Found during:** Task 2 — full suite run
- **Issue:** `payments.test.ts` mocked `../../src/plugins/payments/service` with only `stripe` and `handlePaymentSucceeded`. When Bun 1.3.9 runs the full suite, this mock leaked into `consumer.test.ts` which expects `createPaymentIntent` from the same module, causing `SyntaxError: Export named 'createPaymentIntent' not found`.
- **Fix:** Added `createPaymentIntent: mock(async () => ({ ok: false, error: 'MOCK_NOT_USED' }))` stub to the service mock in `payments.test.ts`, preserving the full module shape expected by other test files.
- **Files modified:** `test/plugins/payments.test.ts`
- **Commit:** 8d92fdd

**Note:** Pre-existing `auth.test.ts` failure (1 test) persists in full suite runs due to Bun 1.3.9 mock contamination from other test files. Auth tests pass in isolation. This pre-existed before Plan 05-02 (confirmed via stash test) and is out of scope.

## Verification Results

- `bun test test/plugins/payments.test.ts` — 5/5 pass
- `grep "paymentsPlugin" src/index.ts` — import and `.use()` present
- `grep "constructEventAsync" src/plugins/payments/index.ts` — HMAC verification present
- `grep "ALREADY_PROCESSED" src/plugins/payments/service.ts` — idempotency guard present
- `grep "pg_notify" src/plugins/payments/service.ts` — dual pg_notify present (2 matches)
- `grep -c "body:" src/plugins/payments/index.ts` — returns 0 (no TypeBox body schema)

## Self-Check: PASSED
