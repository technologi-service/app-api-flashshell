// test/plugins/consumer.test.ts
// Tests for CONS-01 (GET /consumer/menu), CONS-02 (POST /consumer/orders), KDS-01 (pg_notify)
// All service calls are mocked — no live DB required.
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'

// UUIDs for test fixtures — must be valid UUIDs to pass TypeBox format validation
const MENU_ITEM_UUID = '11111111-1111-1111-1111-111111111111'
const UNAVAILABLE_ITEM_UUID = '22222222-2222-2222-2222-222222222222'
const ORDER_UUID = '33333333-3333-3333-3333-333333333333'
const ORDER_ITEM_UUID = '44444444-4444-4444-4444-444444444444'

// Mock service before importing plugin
const mockGetActiveMenu = mock(async () => [
  { id: MENU_ITEM_UUID, name: 'Burger', description: 'A burger', price: '10.00', isAvailable: true }
])
const mockCreateOrder = mock(async (): Promise<{ ok: true; order: { id: string; status: string; totalAmount: string; deliveryAddress: string; items: { itemId: string; name: string; quantity: number; unitPrice: string }[] } } | { ok: false; failures: string[] }> => ({
  ok: true,
  order: {
    id: ORDER_UUID,
    status: 'pending',
    totalAmount: '10.00',
    deliveryAddress: '123 Main St',
    items: [{ itemId: ORDER_ITEM_UUID, name: 'Burger', quantity: 1, unitPrice: '10.00' }]
  }
}))

const mockCreatePaymentIntent = mock(async () => ({
  ok: true as const,
  clientSecret: 'pi_test_secret_123'
}))

const mockGetOrderHistory = mock(async () => [
  {
    id: 'order-1',
    status: 'confirmed',
    totalAmount: '10.00',
    createdAt: new Date('2026-01-01T00:00:00Z')
  }
])

mock.module('../../src/plugins/consumer/service', () => ({
  getActiveMenu: mockGetActiveMenu,
  createOrder: mockCreateOrder,
  getOrderHistory: mockGetOrderHistory
}))

mock.module('../../src/plugins/payments/service', () => ({
  createPaymentIntent: mockCreatePaymentIntent
}))

// Mock authPlugin to inject a customer user context
mock.module('../../src/plugins/auth/index', () => ({
  authPlugin: new (require('elysia').Elysia)({ name: 'better-auth' })
    .macro({
      auth: {
        resolve() {
          return { user: { id: 'user-1', role: 'customer' }, session: {} }
        }
      }
    })
}))

mock.module('../../src/plugins/auth/require-role', () => ({
  requireRole: (..._roles: string[]) =>
    new (require('elysia').Elysia)({ name: 'require-role-mock' })
}))

const { consumerPlugin } = await import('../../src/plugins/consumer/index')
const testApp = new Elysia().use(consumerPlugin)

describe('GET /consumer/menu (CONS-01)', () => {
  it('returns 200 with active menu items', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/consumer/menu', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).toHaveProperty('name')
    expect(body[0]).toHaveProperty('price')
    expect(body[0]).toHaveProperty('isAvailable')
  })
})

describe('POST /consumer/orders (CONS-02)', () => {
  it('returns order with pending status and full shape', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/consumer/orders', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ items: [{ menuItemId: MENU_ITEM_UUID, quantity: 1 }], deliveryAddress: '123 Main St' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('pending')
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('totalAmount')
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('returns 409 when createOrder reports failures (CONS-02 conflict)', async () => {
    mockCreateOrder.mockImplementationOnce(async () => ({
      ok: false,
      failures: [UNAVAILABLE_ITEM_UUID]
    }))
    const res = await testApp.handle(
      new Request('http://localhost/consumer/orders', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ items: [{ menuItemId: UNAVAILABLE_ITEM_UUID, quantity: 1 }], deliveryAddress: '123 Main St' })
      })
    )
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('CONFLICT')
    expect(Array.isArray(body.details)).toBe(true)
    expect(body.details).toContain(UNAVAILABLE_ITEM_UUID)
  })

  it('returns 422 when body has no items array', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/consumer/orders', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
    )
    expect(res.status).toBe(422)
  })
})

describe('GET /consumer/orders (CONS-07)', () => {
  it('returns 200 with order history for the authenticated customer', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/consumer/orders', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).toHaveProperty('status')
    expect(body[0]).toHaveProperty('totalAmount')
    expect(body[0]).toHaveProperty('createdAt')
  })

  it('calls getOrderHistory with the authenticated user id', async () => {
    mockGetOrderHistory.mockClear()
    await testApp.handle(
      new Request('http://localhost/consumer/orders', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(mockGetOrderHistory).toHaveBeenCalledWith('user-1')
  })
})

describe('POST /consumer/orders/:id/pay (CONS-04)', () => {
  it('returns 200 with clientSecret for a pending order', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/consumer/orders/${ORDER_UUID}/pay`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('clientSecret')
    expect(body.clientSecret).toBe('pi_test_secret_123')
  })

  it('returns 404 when order not found', async () => {
    mockCreatePaymentIntent.mockImplementationOnce(async () => ({
      ok: false as const,
      error: 'ORDER_NOT_FOUND'
    }))
    const res = await testApp.handle(
      new Request(`http://localhost/consumer/orders/${ORDER_UUID}/pay`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when order is not pending', async () => {
    mockCreatePaymentIntent.mockImplementationOnce(async () => ({
      ok: false as const,
      error: 'ORDER_NOT_PENDING'
    }))
    const res = await testApp.handle(
      new Request(`http://localhost/consumer/orders/${ORDER_UUID}/pay`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(409)
  })
})
