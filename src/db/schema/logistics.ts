// src/db/schema/logistics.ts
import { pgTable, uuid, numeric, timestamp } from 'drizzle-orm/pg-core'

export const courierLocations = pgTable('courier_locations', {
  courierId: uuid('courier_id').primaryKey(),
  lat: numeric('lat', { precision: 10, scale: 7 }).notNull(),
  lng: numeric('lng', { precision: 10, scale: 7 }).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
  // Primary key on courier_id ensures max 1 row per courier (upsert by PK)
})
