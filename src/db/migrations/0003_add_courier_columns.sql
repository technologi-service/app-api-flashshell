ALTER TABLE "orders"
  ADD COLUMN "courier_id" text,
  ADD COLUMN "delivery_address" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "delivery_address" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_courier_id_user_fk"
  FOREIGN KEY ("courier_id") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "idx_orders_pickup_list"
  ON "orders" ("status", "courier_id")
  WHERE "status" IN ('preparing', 'ready_for_pickup') AND "courier_id" IS NULL;
