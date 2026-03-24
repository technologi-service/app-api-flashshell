// src/db/schema/orders.ts
import { pgTable, uuid, pgEnum, numeric, timestamp, integer, text } from 'drizzle-orm/pg-core'
import { menuItems } from './menu'

export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'picked_up',
  'delivered',
  'cancelled'
])

export const itemStatusEnum = pgEnum('item_status', ['pending', 'preparing', 'ready'])

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: text('customer_id').notNull(),
  status: orderStatusEnum('status').notNull().default('pending'),
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull(),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  courierId: text('courier_id'),                    // nullable, FK to user.id (text PK)
  deliveryAddress: text('delivery_address').notNull(),
  expiresAt: timestamp('expires_at')                // null = no expiry; set to created_at + 30min for pending orders
})

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
  itemStatus: itemStatusEnum('item_status').notNull().default('pending')
})
