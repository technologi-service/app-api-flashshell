import { t } from 'elysia'

// IMPORTANT: No body schema for /webhooks/stripe — intentional.
// Stripe HMAC-SHA256 signature verification requires the raw request body.
// Any body parsing (TypeBox, JSON, etc.) would corrupt the payload before verification.

export const WebhookResponse = t.Object({
  received: t.Boolean(),
  duplicate: t.Optional(t.Boolean())
})
export type WebhookResponse = typeof WebhookResponse.static
