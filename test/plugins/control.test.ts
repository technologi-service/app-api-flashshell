// test/plugins/control.test.ts
// Tests for CTRL-03 (active order dashboard) and CTRL-04 (cash flow report)
// All service calls are mocked — no live DB required.
import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'

// UUIDs for test fixtures — must be valid UUIDs to pass TypeBox format validation
const ORDER_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const ADMIN_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

// Mock service before importing plugin
const mockGetActiveOrders = mock(async () => [
  {
    id: ORDER_UUID,
    status: 'preparing',
    totalAmount: '150.00',
    deliveryAddress: '456 Oak Ave',
    createdAt: new Date('2026-01-15T10:00:00Z').toISOString(),
    items: [{ name: 'Burger', quantity: 2 }]
  }
])

const mockGetCashflowReport = mock(async (_from: string, _to: string) => ({
  totalRevenue: '150.00',
  totalStockCost: '45.00'
}))

mock.module('../../src/plugins/control/service', () => ({
  getActiveOrders: mockGetActiveOrders,
  getCashflowReport: mockGetCashflowReport
}))

// Mock authPlugin to inject an admin user context
mock.module('../../src/plugins/auth/index', () => ({
  authPlugin: new (require('elysia').Elysia)({ name: 'better-auth' })
    .macro({
      auth: {
        resolve() {
          return { user: { id: ADMIN_UUID, role: 'admin' }, session: {} }
        }
      }
    })
}))

mock.module('../../src/plugins/auth/require-role', () => ({
  requireRole: (..._roles: string[]) =>
    new (require('elysia').Elysia)({ name: 'require-role-mock' })
}))

const { controlPlugin } = await import('../../src/plugins/control/index')
const testApp = new Elysia().use(controlPlugin)

describe('GET /control/orders/active (CTRL-03)', () => {
  it('returns 200 with array of active orders with required fields', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/control/orders/active', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).toHaveProperty('status')
    expect(body[0]).toHaveProperty('totalAmount')
    expect(body[0]).toHaveProperty('deliveryAddress')
    expect(body[0]).toHaveProperty('createdAt')
    expect(body[0]).toHaveProperty('items')
    expect(Array.isArray(body[0].items)).toBe(true)
    expect(body[0].items[0]).toHaveProperty('name')
    expect(body[0].items[0]).toHaveProperty('quantity')
  })

  it('returns 200 with empty array when no active orders', async () => {
    mockGetActiveOrders.mockImplementationOnce(async () => [])
    const res = await testApp.handle(
      new Request('http://localhost/control/orders/active', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })
})

describe('GET /control/reports/cashflow (CTRL-04)', () => {
  it('returns 200 with totalRevenue and totalStockCost when service returns values', async () => {
    mockGetCashflowReport.mockImplementationOnce(async () => ({
      totalRevenue: '150.00',
      totalStockCost: '45.00'
    }))
    const res = await testApp.handle(
      new Request('http://localhost/control/reports/cashflow?from=2026-01-01&to=2026-02-01', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.totalRevenue).toBe('150.00')
    expect(body.totalStockCost).toBe('45.00')
  })

  it('returns 200 with zero values when no data in range', async () => {
    mockGetCashflowReport.mockImplementationOnce(async () => ({
      totalRevenue: '0',
      totalStockCost: '0'
    }))
    const res = await testApp.handle(
      new Request('http://localhost/control/reports/cashflow?from=2026-01-01&to=2026-02-01', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.totalRevenue).toBe('0')
    expect(body.totalStockCost).toBe('0')
  })

  it('returns 422 when from param is missing', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/control/reports/cashflow?to=2026-02-01', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(422)
  })

  it('returns 422 when to param is missing', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/control/reports/cashflow?from=2026-01-01', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(422)
  })

  it('returns 422 when both params are missing', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/control/reports/cashflow', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(422)
  })
})
