// test/plugins/couriers.test.ts
// Tests for LOGI-02 (GPS location update with throttle) and LOGI-03 (403 when no active order)
// All service calls are mocked — no live DB required.
import { describe, it, expect, mock } from 'bun:test'
import { Elysia } from 'elysia'

const ORDER_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// Mock service before importing plugin
const mockUpdateCourierLocation = mock(async () => ({
  written: true,
  orderId: ORDER_UUID
}))

mock.module('../../src/plugins/couriers/service', () => ({
  updateCourierLocation: mockUpdateCourierLocation
}))

// Mock authPlugin to inject a delivery user context
mock.module('../../src/plugins/auth/index', () => ({
  authPlugin: new (require('elysia').Elysia)({ name: 'better-auth' })
    .macro({
      auth: {
        resolve() {
          return { user: { id: 'courier-1', role: 'delivery' }, session: {} }
        }
      }
    })
}))

mock.module('../../src/plugins/auth/require-role', () => ({
  requireRole: (..._roles: string[]) =>
    new (require('elysia').Elysia)({ name: 'require-role-mock' })
}))

const { couriersPlugin } = await import('../../src/plugins/couriers/index')
const testApp = new Elysia().use(couriersPlugin)

describe('POST /couriers/location (LOGI-02, LOGI-03)', () => {
  it('returns 200 with { ok: true, written: true } when upsert succeeds', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/couriers/location', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat: 19.432608, lng: -99.133209 })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.written).toBe(true)
  })

  it('returns 200 with { ok: true, written: false } when throttled', async () => {
    mockUpdateCourierLocation.mockImplementationOnce(async () => ({
      written: false,
      orderId: ORDER_UUID
    }))
    const res = await testApp.handle(
      new Request('http://localhost/couriers/location', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat: 19.432608, lng: -99.133209 })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.written).toBe(false)
  })

  it('returns 403 when courier has no active picked_up order', async () => {
    mockUpdateCourierLocation.mockImplementationOnce(async () => ({
      written: false,
      orderId: null
    }))
    const res = await testApp.handle(
      new Request('http://localhost/couriers/location', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat: 19.432608, lng: -99.133209 })
      })
    )
    expect(res.status).toBe(403)
    const body = await res.json() as any
    expect(body.error).toBe('FORBIDDEN')
  })

  it('returns 422 for invalid lat exceeding maximum 90', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/couriers/location', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat: 200, lng: 0 })
      })
    )
    expect(res.status).toBe(422)
  })

  it('returns 422 for missing body fields', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/couriers/location', {
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
