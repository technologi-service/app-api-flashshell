# Phase 5: Payments - Research

**Researched:** 2026-03-18
**Domain:** Stripe Payment Intent API, webhook HMAC verification, idempotency, Elysia raw-body handling
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONS-04 | User can initiate payment for an order via Stripe (Payment Intent) and the system confirms the order upon receiving the Stripe webhook | Stripe SDK `paymentIntents.create()` returns `client_secret`; `payment_intent.succeeded` webhook event advances order `pending → confirmed` with pg_notify to consumer WS channel |
| CONS-05 | Stripe webhook is idempotent — retries do not create duplicate orders | `payment_intents.stripePaymentIntentId` UNIQUE constraint in existing schema; check before UPDATE; early-return if already processed |

</phase_requirements>

---

## Summary

Phase 5 closes the payment loop. When a customer calls `POST /consumer/orders/:id/pay`, the backend creates a Stripe Payment Intent and returns the `client_secret` for the frontend to complete checkout. When Stripe delivers a `payment_intent.succeeded` webhook event, the backend verifies the HMAC-SHA256 signature, checks idempotency, updates the order from `pending` to `confirmed`, and notifies the consumer's WebSocket channel.

The critical challenge is **raw body preservation** for Stripe signature verification. Elysia (like Express) parses request bodies automatically; the webhook route must bypass schema-based body parsing and call `request.text()` directly before running `stripe.webhooks.constructEventAsync()`. This is a framework-specific pitfall with a well-documented workaround for Elysia.

The existing `payment_intents` schema table already has the `stripePaymentIntentId UNIQUE` column required for idempotency. The `orders` status column already supports `pending` and `confirmed`. The only migration needed is to ensure `payment_intents` table is present (the schema file `src/db/schema/payments.ts` exists but needs a migration to actually create the table).

**Primary recommendation:** Use `stripe` npm package v20.x with `constructEventAsync` for webhook verification; access raw body via `request.text()` inside the Elysia route handler (no schema body key); guard idempotency by checking `stripePaymentIntentId` uniqueness before any UPDATE.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| stripe | 20.4.1 | Stripe Node.js SDK — PaymentIntent creation, webhook signature verification | Official SDK, Fetch-API internals work in Bun, verified Bun compatible |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | — | No additional libraries needed | Signature verification, HTTP, and crypto are all in the Stripe SDK |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Payment Intent API | Checkout Sessions API | Checkout Sessions is higher-level (handles tax/discounts), but returns a hosted URL, not a `client_secret`; this project already has order logic and just needs the payment step — Payment Intent is the right level |
| `constructEventAsync` | `constructEvent` | `constructEvent` is sync but requires `Buffer`; `constructEventAsync` is async-native and works better in Bun. Use the async variant. |

**Installation:**

```bash
bun add stripe
```

**Version verification:** Verified via `npm view stripe version` — latest is `20.4.1` as of 2026-03-18.

## Architecture Patterns

### Recommended Project Structure

```
src/plugins/
├── consumer/
│   ├── index.ts         # Add POST /orders/:id/pay route here
│   ├── service.ts       # Add createPaymentIntent() function
│   └── model.ts         # (no changes needed)
└── payments/
    ├── index.ts         # New: paymentsPlugin — POST /webhooks/stripe
    └── service.ts       # New: handleStripeWebhook(), verifyAndProcess()
```

The webhook endpoint lives in a separate `paymentsPlugin` with prefix `/webhooks` because:
1. It must NOT use the `requireRole` auth macro (Stripe calls it, not authenticated users)
2. It needs a custom `onParse` or manual `request.text()` — isolating it prevents the no-body-schema pattern from leaking into other routes

### Pattern 1: Payment Intent Creation

**What:** Customer hits `POST /consumer/orders/:id/pay`. Service creates a Stripe Payment Intent and inserts a row in `payment_intents` with the Stripe PI ID and an idempotency key.
**When to use:** Every time a customer wants to pay for a pending order.

```typescript
// Source: https://docs.stripe.com/api/payment_intents/create?lang=node
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18'
})

// Amount must be in smallest currency unit (cents for USD/ARS)
const paymentIntent = await stripe.paymentIntents.create({
  amount: Math.round(Number(order.totalAmount) * 100),
  currency: 'ars',           // or 'usd' — configure via env
  metadata: { orderId: order.id }
})

// Return client_secret to the frontend — never log or store it
return { clientSecret: paymentIntent.client_secret }
```

**API version note:** Use `'2024-12-18'` (or the current recommended version from the dashboard). Pin the version in code to prevent breaking changes from SDK upgrades.

### Pattern 2: Raw Body Extraction for Webhook Verification

**What:** Elysia auto-parses request bodies. The Stripe webhook route must bypass this and call `request.text()` to get the raw string.
**When to use:** The single `POST /webhooks/stripe` route only.

```typescript
// Source: https://pages.haxiom.io/@zeon256/Handling-Stripe-Webhooks-in-Elysia
// and https://docs.stripe.com/webhooks

export const paymentsPlugin = new Elysia({ name: 'payments', prefix: '/webhooks' })
  .post('/stripe', async ({ request, status }) => {
    // CRITICAL: call request.text() BEFORE any body parsing
    const rawBody = await request.text()
    const signature = request.headers.get('stripe-signature') ?? ''

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err) {
      // Invalid signature — reject immediately, no DB write
      return status(400, { error: 'INVALID_SIGNATURE', message: 'Webhook signature mismatch' })
    }

    if (event.type === 'payment_intent.succeeded') {
      await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent)
    }

    return { received: true }
  })
  // No body schema — intentional. Schema parsing would corrupt the raw body.
```

**CRITICAL:** Do NOT add a `body: t.Object(...)` schema to this route. That would cause Elysia to pre-parse the body before `request.text()` runs, breaking signature verification.

### Pattern 3: Idempotency Guard

**What:** Before updating `orders.status`, check if `stripePaymentIntentId` already exists in `payment_intents` table. If it does, the event is a retry — return early.
**When to use:** Inside `handlePaymentSucceeded()`.

```typescript
// Idempotency check using existing UNIQUE constraint
const existing = await db
  .select({ id: paymentIntents.id })
  .from(paymentIntents)
  .where(eq(paymentIntents.stripePaymentIntentId, paymentIntent.id))
  .limit(1)

if (existing.length > 0) {
  // Already processed — idempotent early return (CONS-05)
  return
}

// Safe to proceed — insert record and update order status
await db.transaction(async (tx) => {
  await tx.insert(paymentIntents).values({
    orderId: orderId,
    stripePaymentIntentId: paymentIntent.id,
    status: 'paid',
    idempotencyKey: paymentIntent.id   // Stripe PI ID is stable across retries
  })

  await tx
    .update(orders)
    .set({ status: 'confirmed', updatedAt: new Date() })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.status, 'pending')    // Guard: only advance from pending
    ))
})

// Notify consumer WebSocket after commit
await notifyOrderConfirmed(orderId)
```

### Pattern 4: WebSocket Notification on Confirmation

**What:** After confirming the order, emit `pg_notify` to `order:{orderId}` channel so the consumer's WebSocket receives `{ event: 'order_confirmed', orderId, status: 'confirmed' }`.
**When to use:** Inside the webhook handler, after successful DB transaction.

```typescript
// Reuse existing pg_notify pattern from consumer/service.ts
await client.query(
  `SELECT pg_notify('flashshell_events', $1::text)`,
  [JSON.stringify({
    channel: `order:${orderId}`,
    event: 'order_confirmed',
    orderId,
    status: 'confirmed'
  })]
)
// Also notify KDS (new order arrived for kitchen)
await client.query(
  `SELECT pg_notify('flashshell_events', $1::text)`,
  [JSON.stringify({
    channel: 'kds',
    event: 'new_order',
    orderId
  })]
)
```

### Anti-Patterns to Avoid

- **Parsing body with TypeBox schema on webhook route:** Breaks HMAC verification — Stripe signature is computed against the exact raw bytes.
- **Using `request.json()` instead of `request.text()`:** Same problem — parsed JSON cannot be re-serialized identically for signature check.
- **Storing `client_secret` in the database:** Client secret is sensitive and ephemeral — never persist it.
- **Trusting the webhook payload without `constructEventAsync`:** An attacker could forge events and confirm orders for free.
- **Not guarding `orders.status = 'pending'` in the UPDATE:** Without the status guard, a retry could re-confirm an order that has already progressed to `preparing`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC-SHA256 signature verification | Custom crypto.createHmac verification | `stripe.webhooks.constructEventAsync()` | Stripe's implementation also validates the timestamp to prevent replay attacks; manual HMAC misses this |
| Idempotency tracking table | Custom events log table | Existing `payment_intents.stripePaymentIntentId UNIQUE` | Already in schema; uniqueness constraint is enforced at DB level — application check + DB constraint = two-layer safety |
| Payment session state machine | Custom payment status tracking | Stripe PaymentIntent `status` field + `payment_intent.succeeded` event | Stripe manages all payment state transitions including retries, 3DS, etc. |

**Key insight:** Stripe's SDK handles replay attack prevention (timestamp check), JSON parsing, and base64 signature decoding. Using raw crypto to verify signatures would miss the timestamp window check that prevents replayed webhooks.

## Common Pitfalls

### Pitfall 1: Body Already Parsed When constructEventAsync Runs

**What goes wrong:** `stripe.webhooks.constructEventAsync()` throws `No signatures found matching the expected signature` even though the secret is correct.
**Why it happens:** Elysia (or any middleware) parsed the JSON body before the route handler ran. The string representation of parsed-then-re-serialized JSON differs from the original bytes Stripe signed.
**How to avoid:** No `body` key in the route definition. Call `request.text()` as the first line of the handler.
**Warning signs:** 400 errors on all webhook deliveries in Stripe Dashboard; `constructEventAsync` throws on every call.

### Pitfall 2: Wrong Webhook Secret

**What goes wrong:** All webhooks rejected with 400 signature mismatch.
**Why it happens:** Stripe CLI local testing uses a different signing secret than the Dashboard-registered endpoint. Test mode and live mode use different secrets.
**How to avoid:** Use `STRIPE_WEBHOOK_SECRET` from the Stripe CLI output during development (`stripe listen --forward-to localhost:3000/webhooks/stripe` prints the secret). Use Dashboard secret in production. Never mix test/live secrets.
**Warning signs:** Works in tests but fails in production, or vice versa.

### Pitfall 3: Missing Migration for payment_intents Table

**What goes wrong:** `relation "payment_intents" does not exist` at runtime.
**Why it happens:** `src/db/schema/payments.ts` defines the Drizzle schema, but no migration SQL file exists yet. Drizzle schema files do not auto-migrate.
**How to avoid:** Wave 0 of Plan 05-01 must run `bun run db:generate` and `bun run db:migrate` to create migration `0005_payment_intents.sql`.
**Warning signs:** Server starts but throws on first pay request.

### Pitfall 4: Amount Currency Mismatch

**What goes wrong:** Stripe rejects the PaymentIntent create call with "amount must be a positive integer".
**Why it happens:** `totalAmount` in the DB is stored as a decimal string (e.g., `"15.50"`); Stripe requires the smallest currency unit as an integer (e.g., `1550` for ARS/USD cents).
**How to avoid:** `Math.round(Number(order.totalAmount) * 100)`. Use `Math.round` not `parseInt` to avoid floating-point truncation.
**Warning signs:** Stripe API returns 400 on payment intent creation.

### Pitfall 5: Race Between Webhook and Status Guard

**What goes wrong:** Two concurrent webhook deliveries both pass the idempotency check and both update the order.
**Why it happens:** SELECT check and UPDATE are not atomic without a transaction.
**How to avoid:** Wrap the idempotency INSERT and order UPDATE in a single Drizzle transaction. The `payment_intents.stripePaymentIntentId UNIQUE` constraint will cause the second concurrent INSERT to fail, protecting against the race at the DB level.
**Warning signs:** Duplicate KDS notifications for the same order.

### Pitfall 6: POST /consumer/orders Still Auto-Confirms

**What goes wrong:** Orders are immediately `confirmed` without going through Stripe, meaning `POST /consumer/orders/:id/pay` is called on an already-confirmed order.
**Why it happens:** Phase 2 `createOrder()` inserts with `status: 'confirmed'` directly (see `service.ts` line 162: `VALUES ($1, 'confirmed', ...)`).
**How to avoid:** Plan 05-01 must update `createOrder()` to insert with `status: 'pending'` instead of `'confirmed'` and remove the KDS pg_notify from order creation (KDS notify moves to the webhook handler). This is the Phase 5 integration point explicitly planned in the Phase 2 CONTEXT.md.
**Warning signs:** Orders never reach the payment step; customers go straight to kitchen without paying.

## Code Examples

Verified patterns from official sources:

### Stripe SDK Initialization

```typescript
// Source: https://docs.stripe.com/api/payment_intents/create?lang=node
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18'
})
```

### Payment Intent Creation

```typescript
// Source: https://docs.stripe.com/api/payment_intents/create?lang=node
const paymentIntent = await stripe.paymentIntents.create({
  amount: Math.round(Number(order.totalAmount) * 100), // cents
  currency: process.env.STRIPE_CURRENCY ?? 'usd',
  metadata: { orderId: order.id, customerId }
})
// Return to frontend
return { clientSecret: paymentIntent.client_secret }
```

### Webhook Signature Verification (Elysia-specific)

```typescript
// Source: https://pages.haxiom.io/@zeon256/Handling-Stripe-Webhooks-in-Elysia
// Source: https://docs.stripe.com/webhooks
const rawBody = await request.text()                     // MUST be first
const sig = request.headers.get('stripe-signature') ?? ''

const event = await stripe.webhooks.constructEventAsync(
  rawBody,
  sig,
  process.env.STRIPE_WEBHOOK_SECRET!
)
// event.type === 'payment_intent.succeeded'
// (event.data.object as Stripe.PaymentIntent).metadata.orderId
```

### Stripe PaymentIntent Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `requires_payment_method` | Awaiting payment method | Frontend collects card |
| `requires_confirmation` | Ready to confirm | Frontend confirms |
| `requires_action` | 3DS or redirect needed | Frontend handles redirect |
| `processing` | Payment in flight | Wait for webhook |
| `succeeded` | Payment captured | Webhook fires `payment_intent.succeeded` |
| `canceled` | Intent cancelled | No action needed |

**Important:** The webhook event name is `payment_intent.succeeded` — NOT `payment.approved` (the success criteria description uses a logical label, not the actual Stripe event name).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `constructEvent` (sync) | `constructEventAsync` | stripe-node v12+ | Async variant is preferred in non-Node runtimes (Bun, Deno, Edge); use it |
| Charges API | Payment Intents API | 2019 | Charges is legacy; Payment Intents handles SCA/3DS automatically |
| Manual HMAC verification | `stripe.webhooks.constructEventAsync()` | Always | SDK includes timestamp replay prevention; manual verification does not |

**Deprecated/outdated:**
- `stripe.charges.create()`: Replaced by Payment Intents in all new integrations
- `constructEvent` (sync version): Still works but `constructEventAsync` is preferred for Bun/Edge

## Open Questions

1. **Currency for this dark kitchen (ARS vs USD)**
   - What we know: Project is LATAM-focused (dark kitchen), Stripe supports ARS
   - What's unclear: Which currency the business operates in
   - Recommendation: Use `STRIPE_CURRENCY` env var, default `'ars'`; planner should note this as a config value the implementer must set

2. **Stripe API version pinning**
   - What we know: Stripe recommends pinning the API version in code; current latest is `2024-12-18`
   - What's unclear: Whether the dashboard is already configured with a specific version
   - Recommendation: Pin `apiVersion: '2024-12-18'` in SDK initialization; update via SDK upgrade, not manually

3. **Payment Intent `confirm: true` vs two-step**
   - What we know: `confirm: true` creates and confirms in one call; without it the PI requires a second confirm from the frontend
   - What's unclear: The success criteria says "receives a Stripe Payment Intent URL to complete checkout" — this suggests the frontend does the confirmation step (two-step flow)
   - Recommendation: Create PI without `confirm: true`; return `client_secret` to frontend; frontend uses Stripe.js to complete payment. This matches the success criteria.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | bun:test (built-in Bun test runner) |
| Config file | none — `bun test` discovers `test/**/*.test.ts` automatically |
| Quick run command | `bun test test/plugins/payments.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONS-04 | `POST /consumer/orders/:id/pay` returns `clientSecret` for a valid pending order | unit (mocked Stripe) | `bun test test/plugins/consumer.test.ts` | Partial — file exists, pay route needs new test cases |
| CONS-04 | `POST /webhooks/stripe` with valid signature updates order to `confirmed` and sends WS notify | unit (mocked Stripe SDK + mocked service) | `bun test test/plugins/payments.test.ts` | ❌ Wave 0 |
| CONS-05 | Second delivery of same `payment_intent.succeeded` event does not change order status | unit (mock returns existing PI row) | `bun test test/plugins/payments.test.ts` | ❌ Wave 0 |
| CONS-04 | Webhook with invalid HMAC-SHA256 signature rejected with 400, no DB write | unit (constructEventAsync throws) | `bun test test/plugins/payments.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test test/plugins/payments.test.ts test/plugins/consumer.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `test/plugins/payments.test.ts` — covers CONS-04 (webhook flow), CONS-05 (idempotency), CONS-04 (signature rejection)
- [ ] Migration `0005_payment_intents.sql` — table does not exist in DB yet (schema file exists, migration does not)
- [ ] `src/plugins/payments/index.ts` — new paymentsPlugin file
- [ ] `src/plugins/payments/service.ts` — new payment service file
- [ ] Install: `bun add stripe`

**Existing test infrastructure pattern to follow:**
Tests mock service modules and the authPlugin using `mock.module()` before importing the plugin. The `payments.test.ts` file should follow the same pattern: mock `../../src/plugins/payments/service` and mock `stripe` SDK directly for the signature verification path.

## Sources

### Primary (HIGH confidence)

- [Stripe API - Create PaymentIntent](https://docs.stripe.com/api/payment_intents/create?lang=node) — SDK initialization, required parameters, TypeScript example
- [Stripe Webhooks documentation](https://docs.stripe.com/webhooks) — `payment_intent.succeeded` event name, `Stripe-Signature` header format, `constructEvent` API, retry behavior
- [Stripe webhook signature verification](https://docs.stripe.com/webhooks/signature) — raw body requirement, HMAC-SHA256 verification process
- `npm view stripe version` — confirmed current version `20.4.1` on 2026-03-18

### Secondary (MEDIUM confidence)

- [Handling Stripe Webhooks in Elysia - Haxiom Pages](https://pages.haxiom.io/@zeon256/Handling-Stripe-Webhooks-in-Elysia) — Elysia-specific `request.text()` pattern for raw body; `constructEventAsync` usage; confirmed Bun compatible with Elysia v1.4.6
- [Compare Checkout Sessions and Payment Intents](https://docs.stripe.com/payments/checkout-sessions-and-payment-intents-comparison) — justification for choosing Payment Intent over Checkout Sessions

### Tertiary (LOW confidence)

- WebSearch results confirming Stripe SDK Bun compatibility (Bun fixed `http.request()` support; stripe-node uses Fetch API internally) — multiple sources agree, not a single official statement

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Stripe v20.4.1 verified via npm; Bun compatibility confirmed from multiple sources
- Architecture: HIGH — raw body pattern verified from Elysia-specific guide + official Stripe docs; idempotency pattern matches existing schema
- Pitfalls: HIGH — body parsing pitfall is officially documented; migration gap is observable from the codebase; currency conversion is a known Stripe API requirement; Phase 2 auto-confirm integration point is documented in 02-CONTEXT.md

**Research date:** 2026-03-18
**Valid until:** 2026-06-18 (Stripe API is stable; SDK version should be re-verified before implementation)
