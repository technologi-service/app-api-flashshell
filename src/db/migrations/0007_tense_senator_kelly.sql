ALTER TABLE "payment_intents" ALTER COLUMN "status" SET DEFAULT 'requires_payment_method';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "failure_reason" text;