// test/plugins/logistics.test.ts
// Tests for LOGI-01 (pickup list and order detail) and LOGI-04 (delivery state machine)
// All service calls are mocked — no live DB required.
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'

// UUIDs for test fixtures — must be valid UUIDs to pass TypeBox format validation
const ORDER_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const COURIER_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// Mock service before importing plugin
const mockGetPickupList = mock(async () => [
  {
    id: ORDER_UUID,
    status: 'ready_for_pickup',
    items: [{ name: 'Burger', quantity: 2 }],
    totalAmount: '20.00',
    deliveryAddress: '123 Main St',
    createdAt: new Date('2026-01-01T00:00:00Z')
  }
])

const mockGetOrderDetail = mock(async (): Promise<
  | { found: true; order: { id: string; status: string; items: { name: string; quantity: number }[]; totalAmount: string; deliveryAddress: string; courierId: string | null; createdAt: Date } }
  | { found: false; reason: 'NOT_FOUND' | 'FORBIDDEN' }
> => ({
  found: true,
  order: {
    id: ORDER_UUID,
    status: 'ready_for_pickup',
    items: [{ name: 'Burger', quantity: 2 }],
    totalAmount: '20.00',
    deliveryAddress: '123 Main St',
    courierId: null,
    createdAt: new Date('2026-01-01T00:00:00Z')
  }
}))

const mockAdvanceOrderStatus = mock(async (): Promise<
  | { ok: true }
  | { ok: false; error: 'INVALID_TRANSITION' | 'ALREADY_CLAIMED' | 'COURIER_BUSY' | 'FORBIDDEN' | 'NOT_FOUND' }
> => ({ ok: true }))

mock.module('../../src/plugins/logistics/service', () => ({
  getPickupList: mockGetPickupList,
  getOrderDetail: mockGetOrderDetail,
  advanceOrderStatus: mockAdvanceOrderStatus
}))

// Mock authPlugin to inject a delivery user context
mock.module('../../src/plugins/auth/index', () => ({
  authPlugin: new (require('elysia').Elysia)({ name: 'better-auth' })
    .macro({
      auth: {
        resolve() {
          return { user: { id: COURIER_UUID, role: 'delivery' }, session: {} }
        }
      }
    })
}))

mock.module('../../src/plugins/auth/require-role', () => ({
  requireRole: (..._roles: string[]) =>
    new (require('elysia').Elysia)({ name: 'require-role-mock' })
}))

const { logisticsPlugin } = await import('../../src/plugins/logistics/index')
const testApp = new Elysia().use(logisticsPlugin)

describe('GET /logistics/orders/ready (LOGI-01)', () => {
  it('returns 200 with array of orders available for pickup', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/logistics/orders/ready', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).toHaveProperty('status')
    expect(body[0]).toHaveProperty('items')
    expect(body[0]).toHaveProperty('totalAmount')
    expect(body[0]).toHaveProperty('deliveryAddress')
    expect(body[0]).toHaveProperty('createdAt')
    expect(Array.isArray(body[0].items)).toBe(true)
  })
})

describe('GET /logistics/orders/:id (LOGI-01)', () => {
  it('returns 200 with full order detail for valid order', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}`, {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('items')
    expect(body).toHaveProperty('totalAmount')
    expect(body).toHaveProperty('deliveryAddress')
  })

  it('returns 404 when order not found', async () => {
    mockGetOrderDetail.mockImplementationOnce(async () => ({ found: false, reason: 'NOT_FOUND' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}`, {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toBe('NOT_FOUND')
  })

  it('returns 403 when courier is not authorized to view order', async () => {
    mockGetOrderDetail.mockImplementationOnce(async () => ({ found: false, reason: 'FORBIDDEN' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}`, {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(403)
    const body = await res.json() as any
    expect(body.error).toBe('FORBIDDEN')
  })
})

describe('PATCH /logistics/orders/:id/status (LOGI-04)', () => {
  it('returns 200 with success=true for valid picked_up transition', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: true }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'picked_up' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.status).toBe('picked_up')
  })

  it('returns 200 with success=true for valid delivered transition', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: true }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'delivered' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.status).toBe('delivered')
  })

  it('returns 409 when order already claimed by another courier', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: false, error: 'ALREADY_CLAIMED' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'picked_up' })
      })
    )
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('ALREADY_CLAIMED')
  })

  it('returns 409 when courier already has an active delivery', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: false, error: 'COURIER_BUSY' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'picked_up' })
      })
    )
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('COURIER_BUSY')
  })

  it('returns 409 when transition is invalid for current order status', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: false, error: 'INVALID_TRANSITION' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'picked_up' })
      })
    )
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('INVALID_TRANSITION')
  })

  it('returns 404 when order not found during status advance', async () => {
    mockAdvanceOrderStatus.mockImplementationOnce(async () => ({ ok: false, error: 'NOT_FOUND' }))
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'picked_up' })
      })
    )
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toBe('NOT_FOUND')
  })

  it('returns 422 for invalid status value in body', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/logistics/orders/${ORDER_UUID}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'invalid' })
      })
    )
    expect(res.status).toBe(422)
  })
})
