// src/db/schema/menu.ts
import { pgTable, uuid, text, boolean, numeric, timestamp } from 'drizzle-orm/pg-core'

export const menuItems = pgTable('menu_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  isAvailable: boolean('is_available').notNull().default(true),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})

export const ingredients = pgTable('ingredients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  stockQuantity: numeric('stock_quantity', { precision: 10, scale: 3 }).notNull().default('0'),
  criticalThreshold: numeric('critical_threshold', { precision: 10, scale: 3 }).notNull().default('0'),
  costPerUnit: numeric('cost_per_unit', { precision: 10, scale: 4 }).notNull().default('0'),
  tenantId: uuid('tenant_id'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})

export const menuItemIngredients = pgTable('menu_item_ingredients', {
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id, { onDelete: 'cascade' }),
  quantityUsed: numeric('quantity_used', { precision: 10, scale: 3 }).notNull()
})
