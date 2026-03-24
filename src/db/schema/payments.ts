// src/db/schema/payments.ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { orders } from './orders'

export const paymentIntents = pgTable('payment_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  stripePaymentIntentId: text('stripe_payment_intent_id').notNull().unique(),
  // status mirrors Stripe PI statuses: requires_payment_method | processing | succeeded | failed | canceled
  status: text('status').notNull().default('requires_payment_method'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  failureReason: text('failure_reason'),             // populated on payment_intent.payment_failed
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})
