CREATE TYPE "public"."item_status" AS ENUM('pending', 'preparing', 'ready');--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "item_status" "item_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_id_item_status_idx"
  ON "order_items" ("order_id", "item_status");
