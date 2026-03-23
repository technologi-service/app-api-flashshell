import { Elysia, t } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import { CashflowQuery, CashflowResponse, ActiveOrder } from './model'
import { getActiveOrders, getCashflowReport } from './service'

export const controlPlugin = new Elysia({ name: 'control', prefix: '/control' })
  .use(authPlugin)
  .use(requireRole('admin'))
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
