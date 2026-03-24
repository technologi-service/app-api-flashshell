import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import {
  CashflowQuery, CashflowResponse, ActiveOrder,
  IngredientCreate, IngredientUpdate, IngredientRestock, IngredientResponse,
  MenuItemCreate, MenuItemUpdate, MenuItemAdminResponse,
  RecipeIngredientSet, RecipeIngredientResponse
} from './model'
import {
  getActiveOrders, getCashflowReport,
  listIngredients, createIngredient, updateIngredient, deleteIngredient, restockIngredient,
  listMenuItemsAdmin, createMenuItem, updateMenuItem, deleteMenuItem,
  getMenuItemIngredients, setMenuItemIngredient, removeMenuItemIngredient
} from './service'

const UuidParam = t.Object({ id: t.String({ format: 'uuid' }) })
const ErrorSchema = t.Object({ error: t.String(), message: t.String() })

export const controlPlugin = new Elysia({ name: 'control', prefix: '/control' })
  .use(authPlugin)
  .use(requireRole('admin'))

  // ---- Orders & Reports ----
  .get('/orders/active', () => getActiveOrders(), {
    auth: true,
    response: t.Array(ActiveOrder),
    tags: ['control'],
    summary: 'Live active orders dashboard',
    description: 'Returns all orders currently in progress (`confirmed`, `preparing`, `ready_for_pickup`, `picked_up`). Designed for the admin live dashboard — combine with the `control` WebSocket channel for real-time updates without polling.'
  })
  .get(
    '/reports/cashflow',
    async ({ query }) => getCashflowReport(query.from, query.to),
    {
      auth: true,
      query: CashflowQuery,
      response: CashflowResponse,
      tags: ['control'],
      summary: 'Cashflow report',
      description: 'Aggregates completed order totals for a given date range. Query params `from` and `to` are ISO 8601 date strings (e.g. `2024-01-01`). Only `delivered` orders are included in the totals.'
    }
  )

  // ---- Ingredients ----
  .get('/ingredients', () => listIngredients(), {
    auth: true,
    response: t.Array(IngredientResponse),
    tags: ['control'],
    summary: 'List all ingredients',
    description: 'Returns all ingredients with current stock levels, critical thresholds, and cost per unit.'
  })
  .post(
    '/ingredients',
    async ({ body }) => createIngredient(body),
    {
      auth: true,
      body: IngredientCreate,
      response: { 201: IngredientResponse },
      status: 201,
      tags: ['control'],
      summary: 'Create ingredient',
      description: 'Creates a new ingredient with initial stock. `criticalThreshold` triggers a low-stock alert via WebSocket when stock falls below it.'
    }
  )
  .put(
    '/ingredients/:id',
    async ({ params, body, status }) => {
      const row = await updateIngredient(params.id, body)
      if (!row) return status(404, { error: 'NOT_FOUND', message: `Ingredient ${params.id} not found` })
      return row
    },
    {
      auth: true,
      params: UuidParam,
      body: IngredientUpdate,
      response: { 200: IngredientResponse, 404: ErrorSchema },
      tags: ['control'],
      summary: 'Update ingredient metadata',
      description: 'Updates name, unit, critical threshold, or cost per unit. To add stock use PATCH /ingredients/:id/restock instead.'
    }
  )
  .patch(
    '/ingredients/:id/restock',
    async ({ params, body, status }) => {
      const row = await restockIngredient(params.id, body.amount)
      if (!row) return status(404, { error: 'NOT_FOUND', message: `Ingredient ${params.id} not found` })
      return row
    },
    {
      auth: true,
      params: UuidParam,
      body: IngredientRestock,
      response: { 200: IngredientResponse, 404: ErrorSchema },
      tags: ['control'],
      summary: 'Restock ingredient',
      description: 'Adds `amount` to the current stock quantity. The operation is additive — pass only the quantity being added, not the new total.'
    }
  )
  .delete(
    '/ingredients/:id',
    async ({ params, status }) => {
      const result = await deleteIngredient(params.id)
      if (!result.ok && result.conflict === 'NOT_FOUND') {
        return status(404, { error: 'NOT_FOUND', message: `Ingredient ${params.id} not found` })
      }
      if (!result.ok && result.conflict === 'INGREDIENT_IN_USE') {
        return status(409, { error: 'INGREDIENT_IN_USE', message: 'Cannot delete ingredient that is part of a recipe. Remove it from all menu items first.' })
      }
      return status(204, null as any)
    },
    {
      auth: true,
      params: UuidParam,
      response: { 204: t.Null(), 404: ErrorSchema, 409: ErrorSchema },
      tags: ['control'],
      summary: 'Delete ingredient',
      description: 'Deletes an ingredient. Returns 409 if the ingredient is used in any menu item recipe.'
    }
  )

  // ---- Menu Items ----
  .get('/menu', () => listMenuItemsAdmin(), {
    auth: true,
    response: t.Array(MenuItemAdminResponse),
    tags: ['control'],
    summary: 'List all menu items (admin)',
    description: 'Returns all menu items including unavailable ones. Use GET /consumer/menu for customer-facing view.'
  })
  .post(
    '/menu',
    async ({ body }) => createMenuItem(body),
    {
      auth: true,
      body: MenuItemCreate,
      response: { 201: MenuItemAdminResponse },
      status: 201,
      tags: ['control'],
      summary: 'Create menu item',
      description: 'Creates a new menu item. Newly created items are available by default unless `isAvailable: false` is set. Assign ingredients via POST /control/menu/:id/ingredients.'
    }
  )
  .put(
    '/menu/:id',
    async ({ params, body, status }) => {
      const row = await updateMenuItem(params.id, body)
      if (!row) return status(404, { error: 'NOT_FOUND', message: `Menu item ${params.id} not found` })
      return row
    },
    {
      auth: true,
      params: UuidParam,
      body: MenuItemUpdate,
      response: { 200: MenuItemAdminResponse, 404: ErrorSchema },
      tags: ['control'],
      summary: 'Update menu item',
      description: 'Updates name, description, price, or availability. To manage ingredients in the recipe, use POST/DELETE /control/menu/:id/ingredients.'
    }
  )
  .delete(
    '/menu/:id',
    async ({ params, status }) => {
      const result = await deleteMenuItem(params.id)
      if (!result.ok && result.conflict === 'NOT_FOUND') {
        return status(404, { error: 'NOT_FOUND', message: `Menu item ${params.id} not found` })
      }
      if (!result.ok && result.conflict === 'MENU_ITEM_HAS_ACTIVE_ORDERS') {
        return status(409, { error: 'MENU_ITEM_HAS_ACTIVE_ORDERS', message: 'Cannot delete menu item with active orders in progress.' })
      }
      return status(204, null as any)
    },
    {
      auth: true,
      params: UuidParam,
      response: { 204: t.Null(), 404: ErrorSchema, 409: ErrorSchema },
      tags: ['control'],
      summary: 'Delete menu item',
      description: 'Deletes a menu item and its recipe (cascade). Returns 409 if there are active orders containing this item.'
    }
  )

  // ---- Recipe ----
  .get(
    '/menu/:id/ingredients',
    async ({ params, status }) => {
      const rows = await getMenuItemIngredients(params.id)
      // Si el menu item no existe, retorna array vacío — validación intencional
      return rows
    },
    {
      auth: true,
      params: UuidParam,
      response: t.Array(RecipeIngredientResponse),
      tags: ['control'],
      summary: 'Get recipe ingredients',
      description: 'Returns all ingredients assigned to a menu item with their quantities and current stock levels.'
    }
  )
  .post(
    '/menu/:id/ingredients',
    async ({ params, body, status }) => {
      // Validar que el menu item existe
      const menuRows = await listMenuItemsAdmin()
      const exists = menuRows.some(m => m.id === params.id)
      if (!exists) return status(404, { error: 'NOT_FOUND', message: `Menu item ${params.id} not found` })

      await setMenuItemIngredient(params.id, body.ingredientId, body.quantityUsed)
      const updated = await getMenuItemIngredients(params.id)
      return updated
    },
    {
      auth: true,
      params: UuidParam,
      body: RecipeIngredientSet,
      response: { 200: t.Array(RecipeIngredientResponse), 404: ErrorSchema },
      tags: ['control'],
      summary: 'Add/update ingredient in recipe',
      description: 'Assigns an ingredient to a menu item with a quantity. If the ingredient is already in the recipe, updates the quantity (upsert). `quantityUsed` is the amount consumed per unit ordered.'
    }
  )
  .delete(
    '/menu/:id/ingredients/:ingredientId',
    async ({ params, status }) => {
      const removed = await removeMenuItemIngredient(params.id, params.ingredientId)
      if (!removed) {
        return status(404, { error: 'NOT_FOUND', message: 'Ingredient not found in this menu item recipe.' })
      }
      return status(204, null as any)
    },
    {
      auth: true,
      params: t.Object({
        id: t.String({ format: 'uuid' }),
        ingredientId: t.String({ format: 'uuid' })
      }),
      response: { 204: t.Null(), 404: ErrorSchema },
      tags: ['control'],
      summary: 'Remove ingredient from recipe',
      description: 'Removes an ingredient from a menu item recipe. Does not delete the ingredient itself.'
    }
  )
