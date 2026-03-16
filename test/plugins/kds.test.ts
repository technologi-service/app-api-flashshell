// test/plugins/kds.test.ts
// Tests for KDS-02 (item status update), KDS-03 (auto-advance to ready_for_pickup),
// KDS-04 (pg_notify kds+logistics), KDS-05 (toggle availability), CONS-06 (consumer notify)
// All service calls are mocked — no live DB required.
import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'

// UUIDs for test fixtures — must be valid UUIDs to pass TypeBox format validation
const ORDER_UUID = '33333333-3333-3333-3333-333333333333'
const ORDER_ITEM_UUID = '44444444-4444-4444-4444-444444444444'
const MENU_ITEM_UUID = '11111111-1111-1111-1111-111111111111'

// Mock service before importing plugin
const mockGetActiveOrders = mock(async () => [
  {
    id: ORDER_UUID,
    status: 'confirmed',
    customerId: 'user-1',
    totalAmount: '20.00',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: ORDER_ITEM_UUID,
        orderId: ORDER_UUID,
        menuItemId: MENU_ITEM_UUID,
        quantity: 2,
        unitPrice: '10.00',
        itemStatus: 'pending'
      }
    ]
  }
])
const mockUpdateItemStatus = mock(async () => ({ found: true, advanced: false }))
const mockToggleAvailability = mock(async () => ({ found: true }))

mock.module('../../src/plugins/kds/service', () => ({
  getActiveOrders: mockGetActiveOrders,
  updateItemStatus: mockUpdateItemStatus,
  toggleAvailability: mockToggleAvailability
}))

// Mock authPlugin to inject a chef user context
mock.module('../../src/plugins/auth/index', () => ({
  authPlugin: new (require('elysia').Elysia)({ name: 'better-auth' })
    .macro({
      auth: {
        resolve() {
          return { user: { id: 'chef-1', role: 'chef' }, session: {} }
        }
      }
    })
}))

mock.module('../../src/plugins/auth/require-role', () => ({
  requireRole: (..._roles: string[]) =>
    new (require('elysia').Elysia)({ name: 'require-role-mock' })
}))

const { kdsPlugin } = await import('../../src/plugins/kds/index')
const testApp = new Elysia().use(kdsPlugin)

describe('GET /kds/orders (KDS-01, KDS-02)', () => {
  it('returns 200 with active orders array', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/kds/orders', {
        headers: { Authorization: 'Bearer test-token' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('items')
  })
})

describe('PATCH /kds/orders/:id/items/:itemId (KDS-02, KDS-03, CONS-06)', () => {
  it('returns 200 when updating item to preparing', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/kds/orders/${ORDER_UUID}/items/${ORDER_ITEM_UUID}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'preparing' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
  })

  it('returns 200 with advanced=true when last item marked ready (KDS-03, KDS-04)', async () => {
    mockUpdateItemStatus.mockImplementationOnce(async () => ({ found: true, advanced: true }))
    const res = await testApp.handle(
      new Request(`http://localhost/kds/orders/${ORDER_UUID}/items/${ORDER_ITEM_UUID}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'ready' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.advanced).toBe(true)
  })

  it('returns 404 when item not found', async () => {
    mockUpdateItemStatus.mockImplementationOnce(async () => ({ found: false, advanced: false }))
    const res = await testApp.handle(
      new Request(`http://localhost/kds/orders/${ORDER_UUID}/items/55555555-5555-5555-5555-555555555555`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'preparing' })
      })
    )
    expect(res.status).toBe(404)
  })

  it('returns 422 for invalid status value', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/kds/orders/${ORDER_UUID}/items/${ORDER_ITEM_UUID}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'invalid_status' })
      })
    )
    expect(res.status).toBe(422)
  })
})

describe('PATCH /kds/menu/:itemId/availability (KDS-05)', () => {
  it('returns 200 when toggling item to inactive', async () => {
    const res = await testApp.handle(
      new Request(`http://localhost/kds/menu/${MENU_ITEM_UUID}/availability`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isAvailable: false })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.isAvailable).toBe(false)
  })

  it('returns 404 when menu item not found', async () => {
    mockToggleAvailability.mockImplementationOnce(async () => ({ found: false }))
    const res = await testApp.handle(
      new Request(`http://localhost/kds/menu/55555555-5555-5555-5555-555555555555/availability`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isAvailable: false })
      })
    )
    expect(res.status).toBe(404)
  })
})
