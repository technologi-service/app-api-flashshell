import { Elysia } from 'elysia'
import { authPlugin } from '../auth/index'
import { requireRole } from '../auth/require-role'
import { CashflowQuery } from './model'
import { getActiveOrders, getCashflowReport } from './service'

export const controlPlugin = new Elysia({ name: 'control', prefix: '/control' })
  .use(authPlugin)
  .use(requireRole('admin'))
  .get('/orders/active', () => getActiveOrders(), { auth: true })
  .get(
    '/reports/cashflow',
    async ({ query }) => getCashflowReport(query.from, query.to),
    { auth: true, query: CashflowQuery }
  )
